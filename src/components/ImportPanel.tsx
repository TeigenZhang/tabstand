'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Lightbox from './Lightbox'

// ============================================================
// Import panel — every path (search · paste-URL · upload · paste ·
// drag-drop) funnels into one staging preview where pages can be
// selected, reordered, and magnified before commit.
//
// The manual path is first-class: when programmatic scraping can't
// reach a sheet (paywall, JS-rendered, odd markup), the user opens
// the original page, saves/screenshots the pages, then drops or
// pastes them here.
// ============================================================

interface Category {
  key: string
  label: string
}
// Just enough about existing songs to warn before mixing pages in
interface SongSummary {
  category: string
  name: string
  title: string
  pages: number
  versions: number
}
interface StagedImage {
  file: string
  url: string
  width?: number
  height?: number
}
interface Staging {
  id: string
  images: StagedImage[]
}
interface SearchResult {
  site: string
  sourceId: string
  free: boolean
  title: string
  pageUrl: string
  thumbnail: string | null
  song?: string
  artist?: string
  confidence?: number
}
// Static source catalogue (drives the filter chips + 17jita jump)
interface SourceInfo {
  id: string
  site: string
  free: boolean
  searchable: boolean
  external: string | null
}
// Per-search status returned alongside results
interface SourceStatus {
  id: string
  site: string
  ok: boolean
  count: number
  error?: string
}

type Tab = 'search' | 'url' | 'upload'

// Confidence at/above which a parsed artist is auto-filled (below: hint only)
const ARTIST_AUTOFILL = 0.75

// Route a remote tab-site image through our caching proxy — defeats
// hotlink protection / mixed-content and keeps the user's IP off the
// source CDN. (See /api/import/thumb.)
const proxiedThumb = (url: string) => `/api/import/thumb?u=${encodeURIComponent(url)}`

// On-demand preview state for a result with no list thumbnail
type PreviewState = { status: 'loading' | 'ready' | 'error'; url?: string }

// Build an external search-engine URL scoped to a site (17jita has no
// SSR-searchable endpoint, so we hand the user off to Bing site search)
const siteSearchUrl = (host: string, query: string) =>
  `https://www.bing.com/search?q=${encodeURIComponent(
    `site:${host.replace(/^https?:\/\//, '')} ${query} 吉他谱`.trim()
  )}`

// Search engines as a discovery fallback when site search comes up dry
const SEARCH_ENGINES = [
  { name: 'Bing', url: (q: string) => `https://www.bing.com/search?q=${q}` },
  { name: '百度', url: (q: string) => `https://www.baidu.com/s?wd=${q}` },
]

// Derive a clean song name from a noisy result title like
// "晴天吉他谱_周杰伦_G调完整版" or "周杰伦《晴天》吉他谱"
function guessSongName(title: string): string {
  const bracket = title.match(/《([^》]+)》/)
  if (bracket) return bracket[1]
  return title.split(/吉他谱|_|（|\(/)[0].trim() || title
}

export default function ImportPanel({
  categories,
  sources,
  songs,
}: {
  categories: Category[]
  sources: SourceInfo[]
  songs: SongSummary[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('search')

  // Form + query state
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [artist, setArtist] = useState('')
  const [version, setVersion] = useState('')
  const [category, setCategory] = useState(categories[0]?.key ?? 'strumming')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [sourceStatus, setSourceStatus] = useState<SourceStatus[] | null>(null)
  // On-demand preview images keyed by pageUrl, for sources whose result
  // list has no thumbnail (吉他社/易唱网). Fetched only on a 预览 click.
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  // pageUrls whose proxied thumbnail failed to load (e.g. an unreachable
  // CDN) — they degrade to the on-demand 预览 button instead of a gap.
  const [thumbErrors, setThumbErrors] = useState<Set<string>>(new Set())
  // Which searchable sources are active. Default: all of them.
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    () => new Set(sources.filter((s) => s.searchable).map((s) => s.id))
  )

  // Staging / preview state
  const [staging, setStaging] = useState<Staging | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [failedUrl, setFailedUrl] = useState('') // original page after a failed scrape
  const [conflict, setConflict] = useState<number | null>(null) // existing page count from a 409
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const versionInputRef = useRef<HTMLInputElement>(null)

  // The song this commit would land on, if it already exists —
  // drives the "already in the library" hint in the preview
  const existing = useMemo(
    () => {
      const n = name.trim()
      // Match the dir name OR the display title — a same-titled song
      // already in a disambiguated dir should still trip the hint
      return (
        songs.find(
          (s) => s.category === category && (s.name === n || s.title === n)
        ) ?? null
      )
    },
    [songs, category, name]
  )
  // Sequence guard: each async action takes a token; a stale response
  // (superseded by a newer action or by navigating away) must not write
  // state back. Bumped by every async start and by navigation.
  const reqRef = useRef(0)

  // Editing the target (url / query) supersedes whatever's loading:
  // invalidate the in-flight request so a stale scrape for the old
  // target can't write back, and free the UI (busy/banner).
  const supersedeTarget = () => {
    if (busy) {
      reqRef.current++
      setBusy(false)
    }
    if (failedUrl || error) {
      setFailedUrl('')
      setError('')
    }
  }

  const togglePage = (file: string) =>
    setExcluded((prev) => {
      const next = new Set(prev)
      next.has(file) ? next.delete(file) : next.add(file)
      return next
    })

  // Reorder pages in the preview — order is what commit uses
  const movePage = (file: string, dir: -1 | 1) =>
    setStaging((s) => {
      if (!s) return s
      const i = s.images.findIndex((im) => im.file === file)
      const j = i + dir
      if (i < 0 || j < 0 || j >= s.images.length) return s
      const images = s.images.slice()
      ;[images[i], images[j]] = [images[j], images[i]]
      return { ...s, images }
    })

  const reset = () => {
    reqRef.current++ // invalidate any in-flight scrape/upload/search
    setStaging(null)
    setExcluded(new Set())
    setError('')
    setFailedUrl('')
    setConflict(null)
    setUrl('')
    setName('')
    setArtist('')
    setVersion('')
  }

  const close = () => {
    if (staging) discard()
    setOpen(false)
    reset()
  }

  // --- Scrape a page into staging (URL tab + search results) ---
  // `hint` carries song/artist already parsed from a search result
  // (with query context); the paste-URL path passes none and the
  // server parses the page <title> instead.
  async function scrape(
    targetUrl: string,
    songName: string,
    hint?: { song?: string; artist?: string; confidence?: number }
  ) {
    const myReq = ++reqRef.current
    setBusy(true)
    setError('')
    setFailedUrl('')
    try {
      const res = await fetch('/api/import/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          name: songName,
          songHint: hint?.song,
          artistHint: hint?.artist,
          confidence: hint?.confidence,
        }),
      })
      const data = await res.json()
      if (myReq !== reqRef.current) return // superseded — drop stale result
      if (!res.ok) throw new Error(data.error ?? '抓取失败')
      // Don't clobber fields the user has since typed — only auto-fill
      // when still empty. Artist fills only above the confidence bar.
      const meta = data.meta as { song?: string; artist?: string; confidence?: number } | undefined
      setName((cur) => (cur.trim() ? cur : meta?.song || songName))
      if (meta?.artist && (meta.confidence ?? 0) >= ARTIST_AUTOFILL) {
        setArtist((cur) => (cur.trim() ? cur : meta.artist!))
      }
      setStaging({ id: data.id, images: data.images })
      setExcluded(new Set())
      setConflict(null) // fresh staging voids any previous 409
    } catch (e) {
      if (myReq !== reqRef.current) return
      setError(e instanceof Error ? e.message : '抓取失败')
      setFailedUrl(targetUrl) // offer "打开原页" + 上传 as the way out
    } finally {
      if (myReq === reqRef.current) setBusy(false)
    }
  }

  async function runSearch(srcSet: Set<string> = selectedSources) {
    if (!query.trim()) return
    if (srcSet.size === 0) {
      setError('请至少选择一个谱源')
      setResults([])
      setSourceStatus(null)
      return
    }
    const myReq = ++reqRef.current
    setBusy(true)
    setError('')
    setFailedUrl('') // a new search supersedes any prior failed scrape
    setResults(null)
    setSourceStatus(null)
    setPreviews({}) // drop stale on-demand previews from the last query
    setThumbErrors(new Set())
    try {
      const sourcesParam = encodeURIComponent(Array.from(srcSet).join(','))
      const res = await fetch(
        `/api/import/search?q=${encodeURIComponent(query.trim())}&sources=${sourcesParam}`
      )
      const data = await res.json()
      if (myReq !== reqRef.current) return
      setResults(data.results ?? [])
      setSourceStatus(data.sources ?? null)
    } catch {
      if (myReq === reqRef.current) setError('搜索失败')
    } finally {
      if (myReq === reqRef.current) setBusy(false)
    }
  }

  // Toggle a source on/off; re-run immediately if a search is showing
  function toggleSource(id: string) {
    const next = new Set(selectedSources)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelectedSources(next)
    if (results !== null && query.trim()) runSearch(next)
  }

  // On-demand: fetch the first sheet image of one result (sources with no
  // list thumbnail) and show it inline. One request per click — never a
  // search-time burst — so it can't get the server IP rate-limited.
  async function loadPreview(pageUrl: string) {
    setPreviews((p) => ({ ...p, [pageUrl]: { status: 'loading' } }))
    try {
      const res = await fetch(`/api/import/preview?url=${encodeURIComponent(pageUrl)}`)
      const data = await res.json()
      if (!res.ok || !data.image) throw new Error()
      setPreviews((p) => ({ ...p, [pageUrl]: { status: 'ready', url: data.image } }))
      // Give the freshly-fetched preview image a clean shot at rendering
      setThumbErrors((prev) => {
        if (!prev.has(pageUrl)) return prev
        const next = new Set(prev)
        next.delete(pageUrl)
        return next
      })
    } catch {
      setPreviews((p) => ({ ...p, [pageUrl]: { status: 'error' } }))
    }
  }

  // --- Stage local images (file input · drag-drop · paste) ---
  async function stageFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    const myReq = ++reqRef.current
    setBusy(true)
    setError('')
    setFailedUrl('')
    try {
      const form = new FormData()
      images.forEach((f, i) => form.append('files', f, f.name || `paste-${i + 1}.png`))
      const res = await fetch('/api/import/upload', { method: 'POST', body: form })
      const data = await res.json()
      if (myReq !== reqRef.current) return
      if (!res.ok) throw new Error(data.error ?? '上传失败')
      setStaging(data)
      setExcluded(new Set())
      setConflict(null) // fresh staging voids any previous 409
    } catch (e) {
      if (myReq !== reqRef.current) return
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      if (myReq === reqRef.current) setBusy(false)
    }
  }

  async function commit(mode?: 'append' | 'newsong') {
    if (!staging || !name.trim()) {
      setError('请填写歌名')
      return
    }
    const keep = staging.images.map((i) => i.file).filter((f) => !excluded.has(f))
    if (keep.length === 0) {
      setError('至少保留一页')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: staging.id,
          category,
          name,
          artist: artist.trim() || undefined,
          version: version || undefined,
          files: keep, // display order = page order
          mode,
        }),
      })
      const data = await res.json()
      // 409 → the target already has pages; surface the choice instead
      // of silently interleaving two arrangements
      if (res.status === 409 && data.conflict) {
        setConflict(data.existingPages ?? 0)
        return
      }
      if (!res.ok) throw new Error(data.error ?? '入库失败')
      reset()
      setOpen(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '入库失败')
    } finally {
      setBusy(false)
    }
  }

  function discard() {
    if (staging) {
      fetch('/api/import/commit', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: staging.id }),
      })
    }
    setStaging(null)
    setExcluded(new Set())
    setConflict(null) // the 409 belonged to the discarded staging
  }

  // Paste images anywhere in the panel — but only capture image
  // pastes, so pasting text into the song-name / search box still works
  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length > 0) {
      e.preventDefault()
      stageFiles(files)
    }
  }

  // Drag-drop local image files (URL drops are ignored — they'd need
  // to re-run the SSRF guard; first version is local files only)
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (files.length > 0) stageFiles(files)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-stone-950 shadow-lg shadow-amber-900/30 transition-colors hover:bg-amber-400"
      >
        <span className="text-base leading-none">＋</span> 导入
      </button>
    )
  }

  const switchTo = (t: Tab) => {
    reqRef.current++ // invalidate any in-flight request when leaving a tab
    setTab(t)
    discard()
    setError('')
    setFailedUrl('')
    if (t !== 'search') setResults(null)
  }

  return (
    <div className="modal-overlay">
      {lightbox && (
        <Lightbox
          urls={lightbox.urls}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNav={(d) =>
            setLightbox((lb) =>
              lb ? { ...lb, index: (lb.index + d + lb.urls.length) % lb.urls.length } : lb
            )
          }
        />
      )}

      <div
        className="modal-card max-w-xl"
        onPaste={onPaste}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">导入吉他谱</h2>
          <button onClick={close} className="text-stone-400 transition-colors hover:text-stone-100" aria-label="关闭">
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-xl bg-stone-900 p-1">
          {([['search', '搜歌名'], ['url', '贴网址'], ['upload', '传图片']] as const).map(
            ([key, label]) => (
              <button
                key={key}
                onClick={() => switchTo(key)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === key ? 'bg-amber-500 text-stone-950' : 'text-stone-400 hover:text-stone-100'
                }`}
              >
                {label}
              </button>
            )
          )}
        </div>

        {/* Drag overlay hint */}
        {dragging && (
          <div className="mb-3 rounded-lg border-2 border-dashed border-amber-500/60 bg-amber-950/20 py-6 text-center text-sm text-amber-300">
            松手即上传图片
          </div>
        )}

        {/* Shared failure fallback — covers BOTH the search→click path
            and the URL tab. Shown whenever a scrape failed; the scrape
            button stays available underneath so retry isn't blocked. */}
        {failedUrl && !staging && (
          <div className="mb-3 flex flex-col gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 p-3">
            <p className="text-xs text-amber-200/90">
              {error || '抓不到这页。'}打开原站登录/购买后，把你有权使用的图片用「传图片」导入。
            </p>
            <div className="flex gap-2">
              <a
                href={failedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 rounded-lg border border-stone-600 py-2 text-center text-sm text-stone-200 hover:bg-stone-800"
              >
                打开原页 ↗
              </a>
              <button
                onClick={() => switchTo('upload')}
                className="flex-1 rounded-lg bg-amber-500 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400"
              >
                传图片
              </button>
              <button
                onClick={() => { setFailedUrl(''); setError('') }}
                className="rounded-lg border border-stone-700 px-3 py-2 text-sm text-stone-300 hover:bg-stone-800"
              >
                关闭
              </button>
            </div>
          </div>
        )}

        {staging ? (
          <StagingPreview
            staging={staging}
            excluded={excluded}
            name={name}
            artist={artist}
            version={version}
            category={category}
            categories={categories}
            existing={existing}
            conflict={conflict}
            versionInputRef={versionInputRef}
            busy={busy}
            error={error}
            onToggle={togglePage}
            onMove={movePage}
            onMagnify={(i) => setLightbox({ urls: staging.images.map((s) => s.url), index: i })}
            onName={(v) => {
              setName(v)
              setConflict(null) // a different target voids the previous 409
            }}
            onArtist={setArtist}
            onVersion={(v) => {
              setVersion(v)
              setConflict(null)
            }}
            onCategory={(v) => {
              setCategory(v)
              setConflict(null)
            }}
            onCommit={() => commit()}
            onAppend={() => commit('append')}
            onNewSong={() => commit('newsong')}
            onDiscard={discard}
          />
        ) : (
          <>
            {tab === 'search' && (
              <SearchTab
                query={query}
                results={results}
                sources={sources}
                selectedSources={selectedSources}
                sourceStatus={sourceStatus}
                previews={previews}
                thumbErrors={thumbErrors}
                busy={busy}
                error={failedUrl ? '' : error} // failure shown in the banner above
                onQuery={(v) => {
                  setQuery(v)
                  supersedeTarget() // drop any in-flight scrape + stale banner
                }}
                onSearch={() => runSearch()}
                onToggleSource={toggleSource}
                onPreview={loadPreview}
                onThumbError={(pageUrl) =>
                  setThumbErrors((prev) => {
                    if (prev.has(pageUrl)) return prev
                    const next = new Set(prev)
                    next.add(pageUrl)
                    return next
                  })
                }
                onPick={(r) =>
                  scrape(r.pageUrl, r.song || guessSongName(r.title), {
                    song: r.song,
                    artist: r.artist,
                    confidence: r.confidence,
                  })
                }
                onMagnify={(thumb) => setLightbox({ urls: [thumb], index: 0 })}
              />
            )}
            {tab === 'url' && (
              <UrlTab
                url={url}
                name={name}
                busy={busy}
                error={failedUrl ? '' : error} // failure shown in the banner above
                onUrl={(v) => {
                  setUrl(v)
                  supersedeTarget() // drop any in-flight scrape + stale banner
                }}
                onName={setName}
                onScrape={() => scrape(url, name)}
              />
            )}
            {tab === 'upload' && (
              <UploadTab
                busy={busy}
                error={error}
                fileInputRef={fileInputRef}
                onFiles={(fl) => stageFiles(Array.from(fl))}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Staging preview — select / reorder / magnify, then commit
// ============================================================
function StagingPreview(props: {
  staging: Staging
  excluded: Set<string>
  name: string
  artist: string
  version: string
  category: string
  categories: Category[]
  existing: SongSummary | null
  conflict: number | null
  versionInputRef: React.RefObject<HTMLInputElement>
  busy: boolean
  error: string
  onToggle: (file: string) => void
  onMove: (file: string, dir: -1 | 1) => void
  onMagnify: (index: number) => void
  onName: (v: string) => void
  onArtist: (v: string) => void
  onVersion: (v: string) => void
  onCategory: (v: string) => void
  onCommit: () => void
  onAppend: () => void
  onNewSong: () => void
  onDiscard: () => void
}) {
  const { staging, excluded } = props
  const kept = staging.images.length - excluded.size
  return (
    <div>
      <p className="mb-1 text-sm text-stone-400">
        共 {staging.images.length} 张，入库 {kept} 张
      </p>
      <p className="mb-2 text-xs text-stone-500">点图选/弃 · ↑↓ 调页序 · 🔍 看大图</p>
      {staging.images.length === 1 && (
        <p className="mb-2 rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
          ⚠️ 只有 1 页。若这首本该多页，可能是付费预览——打开原站登录/购买后，
          把你有权使用的图片用「传图片」导入。
        </p>
      )}
      <div className="mb-4 grid max-h-72 grid-cols-3 gap-2 overflow-y-auto rounded-lg border border-stone-800 p-2">
        {staging.images.map((img, i) => {
          const off = excluded.has(img.file)
          return (
            <div key={img.file} className="relative" title={img.width ? `${img.width}×${img.height}` : img.file}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.file}
                onClick={() => props.onToggle(img.file)}
                className={`w-full cursor-pointer rounded bg-white transition-opacity ${off ? 'opacity-25' : ''}`}
              />
              <span
                className={`pointer-events-none absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  off ? 'bg-stone-700 text-stone-400' : 'bg-amber-500 text-stone-950'
                }`}
              >
                {off ? '+' : '✓'}
              </span>
              {/* page-order badge */}
              <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                {i + 1}
              </span>
              {/* reorder + magnify controls */}
              <div className="absolute bottom-1 left-1 flex gap-1">
                <button
                  onClick={() => props.onMove(img.file, -1)}
                  disabled={i === 0}
                  aria-label="上移"
                  className="flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white hover:bg-black/85 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  onClick={() => props.onMove(img.file, 1)}
                  disabled={i === staging.images.length - 1}
                  aria-label="下移"
                  className="flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white hover:bg-black/85 disabled:opacity-30"
                >
                  ↓
                </button>
              </div>
              <button
                onClick={() => props.onMagnify(i)}
                aria-label="放大查看"
                className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white hover:bg-black/85"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <circle cx="11" cy="11" r="7" />
                  <path strokeLinecap="round" d="m20 20-3.5-3.5M11 8v6M8 11h6" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            value={props.name}
            onChange={(e) => props.onName(e.target.value)}
            placeholder="歌名（必填）"
            className="field flex-1"
          />
          <select
            value={props.category}
            onChange={(e) => props.onCategory(e.target.value)}
            className="rounded-lg border border-stone-700 bg-stone-900 px-3 py-2 text-sm outline-none"
          >
            {props.categories.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <input
            value={props.artist}
            onChange={(e) => props.onArtist(e.target.value)}
            placeholder="歌手（可选，如「周杰伦」）"
            className="field flex-1"
          />
          <input
            ref={props.versionInputRef}
            value={props.version}
            onChange={(e) => props.onVersion(e.target.value)}
            placeholder="版本名（可选；留空入主目录）"
            className="field flex-1"
          />
        </div>

        {/* Pre-commit hint: the song already exists */}
        {props.existing && !props.version.trim() && props.conflict === null && (
          <p className="rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
            ⚠️ 库里已有《{props.name.trim()}》（{props.existing.pages} 页
            {props.existing.versions > 0 ? ` · ${props.existing.versions} 个版本` : ''}
            ）。若这是另一个编配，填个版本名；直接入库会再次确认。
          </p>
        )}

        {/* 409 from commit: choose append / version / keep editing */}
        {props.conflict !== null && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-700/40 bg-amber-950/30 p-3">
            <p className="text-xs text-amber-200/90">
              ⚠️ 库里已有同名《{props.name.trim()}》（{props.conflict} 页）。这是…？
            </p>
            {/* Same title, different song (e.g. 不同歌手的同名歌) — the
                primary intent here. Lands as a separate entry. */}
            <button
              onClick={props.onNewSong}
              disabled={props.busy}
              className="rounded-lg bg-amber-500 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:opacity-50"
            >
              另一首同名歌（如不同歌手）— 单独入库
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => props.versionInputRef.current?.focus()}
                disabled={props.busy}
                className="flex-1 rounded-lg border border-stone-600 py-2 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50"
              >
                同一首的另一编配 — 填版本名
              </button>
              <button
                onClick={props.onAppend}
                disabled={props.busy}
                className="flex-1 rounded-lg border border-stone-600 py-2 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50"
              >
                同一份的后续页 — 追加
              </button>
            </div>
            {props.artist.trim() && (
              <p className="text-[11px] text-stone-500">
                「单独入库」会存到「{props.name.trim()} ({props.artist.trim()})」目录，列表仍显示《{props.name.trim()}》
              </p>
            )}
          </div>
        )}

        {props.error && <p className="text-sm text-red-400">{props.error}</p>}
        <div className="flex gap-2">
          <button
            onClick={props.onCommit}
            disabled={props.busy}
            className="flex-1 rounded-lg bg-amber-500 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {props.busy ? '入库中…' : '确认入库'}
          </button>
          <button
            onClick={props.onDiscard}
            disabled={props.busy}
            className="rounded-lg border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:bg-stone-800"
          >
            丢弃
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// Search tab
// ============================================================
function SearchTab(props: {
  query: string
  results: SearchResult[] | null
  sources: SourceInfo[]
  selectedSources: Set<string>
  sourceStatus: SourceStatus[] | null
  previews: Record<string, PreviewState>
  thumbErrors: Set<string>
  busy: boolean
  error: string
  onQuery: (v: string) => void
  onSearch: () => void
  onToggleSource: (id: string) => void
  onPreview: (pageUrl: string) => void
  onThumbError: (pageUrl: string) => void
  onPick: (r: SearchResult) => void
  onMagnify: (thumb: string) => void
}) {
  const q = encodeURIComponent(props.query.trim() ? `${props.query.trim()} 吉他谱` : '')
  const searchable = props.sources.filter((s) => s.searchable)
  const external = props.sources.filter((s) => !s.searchable && s.external)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && props.onSearch()}
          placeholder="搜歌名或「歌手+歌名」，如：五月天任性"
          className="field flex-1"
        />
        <button
          onClick={props.onSearch}
          disabled={props.busy || !props.query.trim()}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:opacity-50"
        >
          {props.busy ? '搜索中…' : '搜索'}
        </button>
      </div>

      {/* Source filter: toggle which sites to search. 17jita can't be
          SSR-searched (nginx-blocked), so it's a站外搜索 jump instead. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-stone-500">谱源</span>
        {searchable.map((s) => {
          const on = props.selectedSources.has(s.id)
          const st = props.sourceStatus?.find((x) => x.id === s.id)
          const note = st ? (!st.ok ? ` ·${st.error ?? '失败'}` : st.count === 0 ? ' ·0' : '') : ''
          return (
            <button
              key={s.id}
              onClick={() => props.onToggleSource(s.id)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                on
                  ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                  : 'border-stone-700 text-stone-500 hover:text-stone-300'
              }`}
            >
              {s.site}
              {!s.free && <span className="text-[10px] text-amber-500/70">付</span>}
              {note && <span className="text-stone-500">{note}</span>}
            </button>
          )
        })}
        {external.map((s) => (
          <a
            key={s.id}
            href={siteSearchUrl(s.external!, props.query.trim())}
            target="_blank"
            rel="noopener noreferrer"
            title="站内搜不到？去站外搜，找到谱页后用「贴网址」抓取"
            className="rounded-full border border-dashed border-stone-600 px-2.5 py-0.5 text-xs text-stone-400 hover:border-stone-400 hover:text-stone-200"
          >
            {s.site} ↗
          </a>
        ))}
      </div>

      {props.error && <p className="text-sm text-red-400">{props.error}</p>}

      {props.results && props.results.length === 0 && (
        <p className="py-4 text-center text-sm text-stone-500">站内没搜到，试试下方搜索引擎，或用「贴网址」「传图片」</p>
      )}
      {props.results && props.results.length > 0 && (
        <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {props.results.map((r) => {
            const pv = props.previews[r.pageUrl]
            // A ready on-demand preview WINS over a list thumbnail: the user
            // only fetches one when the list thumbnail is absent or broke, so
            // it must not be shadowed by the same failing r.thumbnail.
            const previewUrl = pv?.status === 'ready' ? pv.url ?? null : null
            const thumbUrl = previewUrl ?? (r.thumbnail ? proxiedThumb(r.thumbnail) : null)
            // A thumbnail that failed to load (unreachable CDN, hotlink
            // block) degrades to the 预览 button rather than an empty gap.
            const showThumb = thumbUrl && !props.thumbErrors.has(r.pageUrl)
            return (
            <li key={r.pageUrl} className="flex items-center gap-3 rounded-lg border border-stone-800 p-2 hover:bg-stone-800/60">
              {showThumb ? (
                <button onClick={() => props.onMagnify(thumbUrl)} aria-label="放大查看" className="group relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumbUrl}
                    alt=""
                    loading="lazy"
                    className="h-14 w-20 rounded bg-white object-cover object-top"
                    onError={() => props.onThumbError(r.pageUrl)}
                  />
                  <span className="absolute inset-0 flex items-center justify-center rounded text-transparent transition-colors group-hover:bg-black/40 group-hover:text-white">
                    🔍
                  </span>
                </button>
              ) : (
                // No list thumbnail (吉他社/易唱网) — fetch the first sheet
                // image on demand. One request per click, only if the user
                // wants a peek before committing to a full scrape.
                <button
                  onClick={() => props.onPreview(r.pageUrl)}
                  disabled={pv?.status === 'loading'}
                  title="抓取这条的首张谱图预览一眼"
                  className="group flex h-14 w-20 shrink-0 flex-col items-center justify-center gap-0.5 rounded bg-stone-800 text-[10px] text-stone-400 hover:bg-stone-700 disabled:opacity-70"
                >
                  {pv?.status === 'loading' ? (
                    <span className="animate-pulse">取图中…</span>
                  ) : pv?.status === 'error' ? (
                    <>
                      <span className="text-stone-500">{r.site}</span>
                      <span className="text-amber-400">↻ 重试</span>
                    </>
                  ) : (
                    <>
                      {/* picture icon — calmer than an eye, and semantically
                          "peek at the sheet image" */}
                      <svg
                        className="h-4 w-4 text-stone-500 transition-colors group-hover:text-stone-300"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.7}
                        aria-hidden="true"
                      >
                        <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
                        <circle cx="8.5" cy="10" r="1.5" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4 16.5 4.2-4.2a1.5 1.5 0 0 1 2.1 0L15 17m-1.5-2.5 1.7-1.7a1.5 1.5 0 0 1 2.1 0L20 15" />
                      </svg>
                      <span>预览</span>
                    </>
                  )}
                </button>
              )}
              <button onClick={() => props.onPick(r)} disabled={props.busy} className="min-w-0 flex-1 text-left disabled:opacity-50">
                <span className="block truncate text-sm text-stone-200">{r.title}</span>
                <span className="flex items-center gap-1.5 text-xs text-stone-500">
                  <span className={`rounded px-1 py-px text-[10px] font-medium ${r.free ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                    {r.free ? '免费' : '付费预览'}
                  </span>
                  {r.site} · 点击抓取
                </span>
              </button>
              <a
                href={r.pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-md border border-stone-700 px-2 py-1 text-xs text-stone-300 hover:bg-stone-800"
                title="在新标签打开原页，自己看/存图"
              >
                打开 ↗
              </a>
            </li>
            )
          })}
        </ul>
      )}

      {/* search-engine discovery fallback */}
      {props.query.trim() && (
        <div className="flex items-center gap-2 text-xs text-stone-500">
          <span>搜不到？去</span>
          {SEARCH_ENGINES.map((s) => (
            <a key={s.name} href={s.url(q)} target="_blank" rel="noopener noreferrer" className="rounded border border-stone-700 px-2 py-0.5 text-stone-300 hover:bg-stone-800">
              {s.name}
            </a>
          ))}
          <span>找到后用「贴网址」或「传图片」入库</span>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Paste-URL tab — with a manual fallback when scraping fails
// ============================================================
function UrlTab(props: {
  url: string
  name: string
  busy: boolean
  error: string
  onUrl: (v: string) => void
  onName: (v: string) => void
  onScrape: () => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <input
        value={props.url}
        onChange={(e) => props.onUrl(e.target.value)}
        placeholder="谱页网址（jita5 / jitaxp / 17jita / B站专栏…）"
        className="field"
      />
      <input
        value={props.name}
        onChange={(e) => props.onName(e.target.value)}
        placeholder="歌名（可选，帮助过滤无关图片）"
        className="field"
      />
      {/* scrape button stays available so the user can always retry */}
      <button
        onClick={props.onScrape}
        disabled={props.busy || !props.url.trim()}
        className="rounded-lg bg-amber-500 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:opacity-50"
      >
        {props.busy ? '抓取中…（逐张下载，请稍候）' : '抓取预览'}
      </button>
    </div>
  )
}

// ============================================================
// Upload tab — file picker + drag/paste hint
// ============================================================
function UploadTab(props: {
  busy: boolean
  error: string
  fileInputRef: React.RefObject<HTMLInputElement>
  onFiles: (files: FileList) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => props.fileInputRef.current?.click()}
        className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-stone-700 bg-stone-900/40 py-8 text-sm text-stone-400 hover:border-amber-500/50 hover:text-stone-200"
      >
        <span className="text-2xl">⬆</span>
        点此选择图片，或把图片拖进来 / 截图后 Ctrl+V 粘贴
      </button>
      <input
        ref={props.fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && props.onFiles(e.target.files)}
      />
      <p className="text-xs text-stone-500">
        按文件名顺序作为页序，入库前还能在预览里调整。多选可一次传整首。
      </p>
      {props.error && <p className="text-sm text-red-400">{props.error}</p>}
    </div>
  )
}
