'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { Manifest, Song } from '@/lib/manifest'

// ============================================================
// Song browser — thumbnail card grid with category tabs and
// pinyin quick search. Each card shows the top of the first
// page so a song is recognizable at a glance.
// ============================================================

const enc = (s: string) => encodeURIComponent(s)

// Cover = first page of the main arrangement, or the first
// version's first page for version-only songs. ?v= busts the 1h
// image cache when an edit rewrites pages behind stable names.
function coverUrl(song: Song): string | null {
  const v = `?v=${song.rev ?? 0}`
  if (song.pages.length > 0) {
    return `/api/img/${enc(song.category)}/${enc(song.name)}/${enc(song.pages[0])}${v}`
  }
  const ver = song.versions[0]
  if (ver?.pages.length) {
    return `/api/img/${enc(song.category)}/${enc(song.name)}/versions/${enc(ver.name)}/${enc(ver.pages[0])}${v}`
  }
  return null
}

function pageCount(song: Song): number {
  return song.pages.length || song.versions[0]?.pages.length || 0
}

function matches(song: Song, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  // Direct substring match works for Chinese (e.g. 「这」), and
  // covers the artist too (e.g. 「周杰伦」 lists all his songs).
  // Match the DISPLAY title, not the (possibly disambiguated) dir name.
  if (song.title.toLowerCase().includes(q)) return true
  if (song.artist && song.artist.toLowerCase().includes(q)) return true
  // Pinyin / initials only apply to latin input — a Chinese query
  // normalizes to '' and includes('') is always true, which would
  // wrongly match every song. Guard against the empty key.
  const key = q.replace(/[^a-z0-9]/g, '')
  if (!key) return false
  return (
    song.pinyin.includes(key) ||
    song.initials.includes(key) ||
    (song.artistPinyin ?? '').includes(key) ||
    (song.artistInitials ?? '').includes(key)
  )
}

export default function SongList({ manifest }: { manifest: Manifest }) {
  const [category, setCategory] = useState(
    manifest.categories[0]?.key ?? 'strumming'
  )
  const [query, setQuery] = useState('')
  const [artistFilter, setArtistFilter] = useState<string | null>(null)
  const [isNarrow, setIsNarrow] = useState(false)

  // Placeholder copy can't respond to breakpoints in CSS — track it here
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const update = () => setIsNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Artists present in the current category, most songs first
  const artists = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of manifest.songs) {
      if (s.category !== category || !s.artist) continue
      counts.set(s.artist, (counts.get(s.artist) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')
    )
  }, [manifest.songs, category])

  const pickCategory = (key: string) => {
    setCategory(key)
    setArtistFilter(null) // the filter belongs to the old category's list
  }

  const visible = useMemo(
    () =>
      manifest.songs.filter(
        (s) =>
          s.category === category &&
          (!artistFilter || s.artist === artistFilter) &&
          matches(s, query)
      ),
    [manifest.songs, category, artistFilter, query]
  )

  return (
    <div>
      {/* Search */}
      <div className="group relative mb-5">
        <svg
          className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-stone-500 transition-colors group-focus-within:text-amber-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="11" cy="11" r="7" />
          <path strokeLinecap="round" d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            isNarrow
              ? '搜歌名 / 歌手 / 拼音'
              : '搜索歌名 / 歌手 / 拼音 / 首字母（nfgn）'
          }
          autoComplete="off"
          className="w-full rounded-2xl border border-stone-800 bg-stone-900/60 py-3 pl-12 pr-4 text-base text-stone-100 outline-none transition-all duration-200 placeholder:text-stone-500 focus:border-amber-500/60 focus:bg-stone-900 focus:shadow-[0_0_0_4px_rgba(245,158,11,0.10)]"
        />
      </div>

      {/* Category tabs + live result feedback */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="inline-flex gap-1 rounded-full bg-stone-900/80 p-1 ring-1 ring-stone-800">
          {manifest.categories.map(({ key, label }) => {
            const count = manifest.songs.filter((s) => s.category === key).length
            const active = category === key
            return (
              <button
                key={key}
                onClick={() => pickCategory(key)}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all duration-200 ${
                  active
                    ? 'bg-amber-500 text-stone-950 shadow-md shadow-amber-900/40'
                    : 'text-stone-400 hover:text-stone-100'
                }`}
              >
                {label}
                <span className={`font-tuner ml-1.5 text-xs ${active ? 'opacity-70' : 'opacity-50'}`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Only when a filter narrows the list — quiet otherwise */}
        {(query.trim() || artistFilter) && (
          <p className="flex shrink-0 items-center gap-2 text-xs text-stone-500">
            找到
            <span className="font-tuner text-amber-400/90">{visible.length}</span>
            首
            <button
              onClick={() => {
                setQuery('')
                setArtistFilter(null)
              }}
              className="rounded-full border border-stone-800 px-2 py-0.5 text-stone-400 transition-colors hover:border-stone-600 hover:text-stone-100"
            >
              清除
            </button>
          </p>
        )}
      </div>

      {/* Artist filter — only when this category has tagged songs */}
      {artists.length > 0 && (
        <div className="mb-6 flex gap-1.5 overflow-x-auto pb-1 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]">
          <button
            onClick={() => setArtistFilter(null)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              artistFilter === null
                ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                : 'border-stone-800 bg-stone-900/60 text-stone-400 hover:border-stone-700 hover:text-stone-200'
            }`}
          >
            全部歌手
          </button>
          {artists.map(([artist, count]) => {
            const active = artistFilter === artist
            return (
              <button
                key={artist}
                onClick={() => setArtistFilter(active ? null : artist)}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                    : 'border-stone-800 bg-stone-900/60 text-stone-400 hover:border-stone-700 hover:text-stone-200'
                }`}
              >
                {artist}
                <span className="font-tuner ml-1 opacity-60">{count}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Card grid */}
      {visible.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-3xl opacity-40">🎸</p>
          <p className="mt-3 text-sm text-stone-500">
            {query.trim() ? (
              <>没有找到「<span className="text-stone-300">{query.trim()}</span>」</>
            ) : (
              '没有匹配的歌曲'
            )}
          </p>
          {artistFilter && (
            <p className="mt-1.5 text-xs text-stone-600">
              已限定歌手：{artistFilter}
            </p>
          )}
          {(query.trim() || artistFilter) && (
            <button
              onClick={() => {
                setQuery('')
                setArtistFilter(null)
              }}
              className="mt-5 rounded-full border border-stone-700 px-4 py-1.5 text-sm text-stone-300 transition-colors hover:border-amber-500/50 hover:text-amber-300"
            >
              清空筛选
            </button>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
          {visible.map((song, i) => {
            const cover = coverUrl(song)
            // Arrangements = versions + the main sheet (if it still
            // has pages — a fully-split song is version-only)
            const versions =
              song.versions.length + (song.pages.length > 0 ? 1 : 0)
            return (
              <li
                key={`${song.category}/${song.name}`}
                className="animate-fade-up"
                style={{ animationDelay: `${Math.min(i, 16) * 28}ms` }}
              >
                <Link
                  href={`/song/${song.category}/${enc(song.name)}`}
                  className="group block overflow-hidden rounded-xl border border-stone-800 bg-gradient-to-b from-stone-900/70 to-stone-900/40 transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-500/40 hover:shadow-lg hover:shadow-amber-950/30 active:scale-[0.985] active:duration-75"
                >
                  {/* Paper-toned placeholder shows through while lazy covers load */}
                  <div className="relative aspect-[3/4] overflow-hidden bg-[#f0ead9]">
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={cover}
                        alt={song.title}
                        loading="lazy"
                        className="h-full w-full bg-white object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-3xl text-stone-400">
                        🎼
                      </div>
                    )}
                    {/* Hairline paper edge + soft vignette under the badge */}
                    <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-stone-950/15" />
                    <span className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/25 to-transparent" />
                    <span className="font-tuner absolute right-1.5 top-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                      {pageCount(song)}页
                    </span>
                  </div>
                  <div className="px-2.5 py-2">
                    <span className="block truncate text-sm font-medium text-stone-100 transition-colors group-hover:text-amber-300">
                      {song.title}
                    </span>
                    {(song.artist || versions > 1) && (
                      <span className="mt-0.5 block truncate text-xs text-stone-500">
                        {song.artist}
                        {song.artist && versions > 1 && ' · '}
                        {versions > 1 && (
                          <span className="text-amber-500/80">{versions} 个版本</span>
                        )}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
