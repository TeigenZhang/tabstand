'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import Lightbox from './Lightbox'

// ============================================================
// Edit panel — in-place editing for a song already in the
// library, scoped to the page set being viewed (main sheet or
// one version).
//
// Mental model: mark pages "移出" (✗), then choose their fate —
// delete (→ trash), split into a new version, or (from a version
// view) move back into the main sheet. Reordering via ↑↓ applies
// with whichever action is taken. Renames and whole-song /
// whole-version deletion live in the collapsed danger zone.
// ============================================================

interface PageItem {
  file: string
  url: string
}

interface Props {
  category: string
  name: string
  artist: string
  version: string | null
  pages: PageItem[]
  hasVersions: boolean
  /** All version names in manifest (display) order */
  versions: string[]
  /** Page count of the main arrangement (0 = version-only song) */
  mainPages: number
}

export default function EditPanel({
  category,
  name,
  artist,
  version,
  pages,
  hasVersions,
  versions,
  mainPages,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [order, setOrder] = useState<string[]>(() => pages.map((p) => p.file))
  const [out, setOut] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [splitName, setSplitName] = useState('')
  const [renameName, setRenameName] = useState('')
  const [renameVer, setRenameVer] = useState('')
  const [artistValue, setArtistValue] = useState(artist)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [verOrder, setVerOrder] = useState<string[]>(() => versions)
  const [demoteName, setDemoteName] = useState('')

  // Re-sync local state whenever the server-rendered page list changes
  // (after a refresh every surviving page has been renumbered)
  useEffect(() => {
    setOrder(pages.map((p) => p.file))
    setOut(new Set())
  }, [pages])

  // Same for the artist after a setArtist round-trip
  useEffect(() => setArtistValue(artist), [artist])

  // And for the version list after reorder / promote / rename
  useEffect(() => setVerOrder(versions), [versions])

  const urlByFile = useMemo(() => new Map(pages.map((p) => [p.file, p.url])), [pages])
  const baseUrl = `/song/${category}/${encodeURIComponent(name)}`
  const orderChanged = useMemo(
    () => order.join('\n') !== pages.map((p) => p.file).join('\n'),
    [order, pages]
  )
  const outInOrder = order.filter((f) => out.has(f))
  const keepInOrder = order.filter((f) => !out.has(f))

  const toggleOut = (file: string) =>
    setOut((prev) => {
      const next = new Set(prev)
      next.has(file) ? next.delete(file) : next.add(file)
      return next
    })

  const movePage = (file: string, dir: -1 | 1) =>
    setOrder((prev) => {
      const i = prev.indexOf(file)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = prev.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const close = () => {
    setOpen(false)
    setOrder(pages.map((p) => p.file))
    setOut(new Set())
    setError('')
    setSplitName('')
    setRenameName('')
    setRenameVer('')
    setArtistValue(artist)
    setVerOrder(versions)
    setDemoteName('')
  }

  // One mutate call against /api/library; null means failure (error
  // shown). A 409 returns { conflict, existingPages } for the caller
  // to confirm and retry with merge: true.
  async function post(body: Record<string, unknown>): Promise<Record<string, any> | null> {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, name, ...body }),
      })
      const data = await res.json()
      if (res.status === 409 && data.conflict) return data
      if (!res.ok) throw new Error(data.error ?? '操作失败')
      return data
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
      return null
    } finally {
      setBusy(false)
    }
  }

  // Navigate after a successful op; refresh re-renders the server page
  const go = (url?: string) => {
    setOpen(false)
    if (url) router.push(url)
    router.refresh()
  }

  // --- Page-set actions (also apply the current ↑↓ order) ---

  async function saveOrDelete() {
    if (
      out.size > 0 &&
      !window.confirm(`确定删除 ${out.size} 页？删除的页会进回收站（library/.trash），保留 7 天`)
    )
      return
    const data = await post({ op: 'pages', version, keep: keepInOrder })
    if (!data) return
    if (!data.songRemains) go('/')
    else if (version && data.kept === 0) go(baseUrl)
    else go()
  }

  // Move marked pages to a version (or main). A 409 means the
  // target already has pages — confirm, then retry with merge.
  async function moveTo(toVersion: string | null, doneUrl: string) {
    const body = {
      op: 'move',
      fromVersion: version,
      toVersion,
      files: outInOrder,
      sourceOrder: keepInOrder,
    }
    let data = await post(body)
    if (data?.conflict) {
      const target = toVersion ? `版本「${toVersion}」` : '主谱'
      if (
        !window.confirm(
          `${target}已有 ${data.existingPages} 页。确认把标记的 ${outInOrder.length} 页追加到它后面？\n（不同编配建议换个新版本名分开存）`
        )
      )
        return
      data = await post({ ...body, merge: true })
      if (data?.conflict) return // shouldn't happen; bail safely
    }
    if (!data) return
    go(doneUrl)
  }

  const splitToVersion = () => {
    const target = splitName.trim()
    if (!target) {
      setError('请填写新版本名')
      return
    }
    return moveTo(target, `${baseUrl}/v/${encodeURIComponent(target)}`)
  }

  const moveToMain = () => moveTo(null, baseUrl)

  // --- Version management ---

  const verOrderChanged = useMemo(
    () => verOrder.join('\n') !== versions.join('\n'),
    [verOrder, versions]
  )

  const moveVersion = (v: string, dir: -1 | 1) =>
    setVerOrder((prev) => {
      const i = prev.indexOf(v)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = prev.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  async function saveVersionOrder() {
    const data = await post({ op: 'reorderVersions', order: verOrder })
    if (!data) return
    go()
  }

  // Make a version the main arrangement. A non-empty main must be
  // demoted to a named version first — prompt for that name.
  async function promoteToMain(v: string) {
    let demoteTo: string | null = null
    if (mainPages > 0) {
      const input = window.prompt(
        `把「${v}」设为原版后，现在的原版（${mainPages} 页）会保存为一个版本。\n给它起个版本名：`,
        ''
      )
      if (input === null) return
      demoteTo = input.trim()
      if (!demoteTo) {
        setError('需要给当前原版填一个版本名')
        return
      }
    } else if (!window.confirm(`确定把「${v}」设为原版（主谱）？`)) {
      return
    }
    const data = await post({ op: 'promoteVersion', version: v, demoteTo })
    if (!data) return
    go(baseUrl)
  }

  // Main → named version (the song becomes version-only)
  async function demoteMainTo() {
    const target = demoteName.trim()
    if (!target) {
      setError('请填写版本名')
      return
    }
    const data = await post({ op: 'demoteMain', toVersion: target })
    if (!data) return
    go(`${baseUrl}/v/${encodeURIComponent(target)}`)
  }

  // --- Metadata / danger zone ---

  async function saveArtist() {
    const data = await post({ op: 'setArtist', artist: artistValue })
    if (!data) return
    go() // stay on the page, just refresh the manifest-driven UI
  }

  async function doRenameSong() {
    const newName = renameName.trim()
    if (!newName) {
      setError('请填写新歌名')
      return
    }
    const data = await post({ op: 'renameSong', newName })
    if (!data) return
    go(
      `/song/${category}/${encodeURIComponent(data.newName)}` +
        (version ? `/v/${encodeURIComponent(version)}` : '')
    )
  }

  async function doRenameVersion() {
    const newVersion = renameVer.trim()
    if (!version || !newVersion) {
      setError('请填写新版本名')
      return
    }
    const data = await post({ op: 'renameVersion', version, newVersion })
    if (!data) return
    go(`${baseUrl}/v/${encodeURIComponent(data.newVersion)}`)
  }

  async function doDelete() {
    if (version) {
      if (!window.confirm(`确定删除版本「${version}」？整个版本进回收站，保留 7 天`)) return
      const data = await post({ op: 'deleteVersion', version })
      if (!data) return
      go(data.songRemains ? baseUrl : '/')
    } else {
      const suffix = hasVersions ? '（含所有版本）' : ''
      if (!window.confirm(`确定删除整首「${name}」${suffix}？进回收站，保留 7 天`)) return
      const data = await post({ op: 'deleteSong' })
      if (!data) return
      go('/')
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="whitespace-nowrap rounded-lg px-2 py-1 text-sm text-stone-400 transition-colors hover:bg-stone-800 hover:text-stone-100"
        title="编辑页序 / 删页 / 拆版本 / 改名"
      >
        ✎ 编辑
      </button>
    )
  }

  // Portal to <body>: the viewer header has backdrop-blur, and a
  // backdrop-filter ancestor becomes the containing block for
  // position:fixed — rendered in place, this modal would be clipped
  // to the 40px header bar. data-overlay tells SheetViewer to mute
  // its global page-turn keys while the modal is up.
  return createPortal(
    <div data-overlay className="modal-overlay">
      {lightbox !== null && (
        <Lightbox
          urls={order.map((f) => urlByFile.get(f) ?? '')}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onNav={(d) => setLightbox((i) => (i === null ? i : (i + d + order.length) % order.length))}
        />
      )}

      <div className="modal-card max-w-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="truncate text-lg font-semibold">
            编辑「{name}
            {version ? ` · ${version}` : ''}」
          </h2>
          <button onClick={close} className="text-stone-400 transition-colors hover:text-stone-100" aria-label="关闭">
            ✕
          </button>
        </div>

        <p className="mb-2 text-xs text-stone-500">
          点图标记移出（✗）· ↑↓ 调页序 · 🔍 看大图。标记的页可删除、拆成版本
          {version ? '或移回主谱' : ''}。
        </p>

        {/* Page grid */}
        <div className="mb-4 grid max-h-72 grid-cols-3 gap-2 overflow-y-auto rounded-lg border border-stone-800 p-2">
          {order.map((file, i) => {
            const marked = out.has(file)
            return (
              <div key={file} className="relative" title={file}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={urlByFile.get(file)}
                  alt={file}
                  onClick={() => toggleOut(file)}
                  className={`w-full cursor-pointer rounded bg-white transition-opacity ${marked ? 'opacity-25' : ''}`}
                />
                <span
                  className={`pointer-events-none absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                    marked ? 'bg-red-500/90 text-white' : 'bg-amber-500 text-stone-950'
                  }`}
                >
                  {marked ? '✗' : '✓'}
                </span>
                {/* page-order badge */}
                <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                  {i + 1}
                </span>
                {/* reorder + magnify controls */}
                <div className="absolute bottom-1 left-1 flex gap-1">
                  <button
                    onClick={() => movePage(file, -1)}
                    disabled={i === 0}
                    aria-label="上移"
                    className="flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white hover:bg-black/85 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => movePage(file, 1)}
                    disabled={i === order.length - 1}
                    aria-label="下移"
                    className="flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white hover:bg-black/85 disabled:opacity-30"
                  >
                    ↓
                  </button>
                </div>
                <button
                  onClick={() => setLightbox(i)}
                  aria-label="放大查看"
                  className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white hover:bg-black/85"
                >
                  🔍
                </button>
              </div>
            )
          })}
        </div>

        {/* Fate of the marked pages */}
        {out.size > 0 && (
          <div className="mb-3 flex flex-col gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 p-3">
            <p className="text-xs text-amber-200/90">已标记 {out.size} 页，怎么处理？</p>
            <div className="flex gap-2">
              <input
                value={splitName}
                onChange={(e) => setSplitName(e.target.value)}
                placeholder="新版本名（如「弹手吉他」）"
                className="field flex-1"
              />
              <button
                onClick={splitToVersion}
                disabled={busy || !splitName.trim()}
                className="whitespace-nowrap rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:opacity-50"
              >
                拆成版本
              </button>
            </div>
            <div className="flex gap-2">
              {version && (
                <button
                  onClick={moveToMain}
                  disabled={busy}
                  className="flex-1 rounded-lg border border-stone-600 py-2 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50"
                >
                  移回主谱
                </button>
              )}
              <button
                onClick={saveOrDelete}
                disabled={busy}
                className="flex-1 rounded-lg border border-red-800/60 bg-red-950/40 py-2 text-sm font-medium text-red-300 hover:bg-red-900/40 disabled:opacity-50"
              >
                删除这 {out.size} 页
              </button>
            </div>
          </div>
        )}

        {/* Order-only save */}
        {out.size === 0 && orderChanged && (
          <button
            onClick={saveOrDelete}
            disabled={busy}
            className="mb-3 w-full rounded-lg bg-amber-500 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {busy ? '保存中…' : '保存页序'}
          </button>
        )}

        {/* Version management — display order, swap main/version */}
        <details className="mb-2 rounded-lg border border-stone-800">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm text-stone-400 hover:text-stone-200">
            版本管理
          </summary>
          <div className="flex flex-col gap-2 border-t border-stone-800 p-3">
            <p className="text-xs text-stone-500">
              ↑↓ 调版本展示顺序（排第一的作为封面与默认打开）。
              「设为原版」与主谱整体互换。
            </p>

            {mainPages > 0 && (
              <div className="flex items-center gap-2 rounded-lg bg-stone-900/60 px-3 py-2">
                <span className="flex-1 truncate text-sm text-stone-200">
                  原版（主谱）
                </span>
                <span className="font-tuner text-xs text-stone-500">
                  {mainPages}页 · 始终第一
                </span>
              </div>
            )}

            {verOrder.map((v, i) => (
              <div
                key={v}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
                  v === version ? 'bg-amber-500/10 ring-1 ring-inset ring-amber-500/30' : 'bg-stone-900/60'
                }`}
              >
                <span className="flex-1 truncate text-sm text-stone-200" title={v}>
                  {v}
                </span>
                <button
                  onClick={() => moveVersion(v, -1)}
                  disabled={busy || i === 0}
                  aria-label="上移"
                  className="flex h-6 w-6 items-center justify-center rounded-md bg-stone-800 text-stone-300 hover:bg-stone-700 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  onClick={() => moveVersion(v, 1)}
                  disabled={busy || i === verOrder.length - 1}
                  aria-label="下移"
                  className="flex h-6 w-6 items-center justify-center rounded-md bg-stone-800 text-stone-300 hover:bg-stone-700 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  onClick={() => promoteToMain(v)}
                  disabled={busy}
                  className="whitespace-nowrap rounded-md border border-stone-600 px-2 py-1 text-xs text-stone-200 hover:bg-stone-800 disabled:opacity-50"
                >
                  设为原版
                </button>
              </div>
            ))}

            {verOrderChanged && (
              <button
                onClick={saveVersionOrder}
                disabled={busy}
                className="w-full rounded-lg bg-amber-500 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {busy ? '保存中…' : '保存版本顺序'}
              </button>
            )}

            {mainPages > 0 && (
              <div className="flex gap-2 border-t border-stone-800 pt-2">
                <input
                  value={demoteName}
                  onChange={(e) => setDemoteName(e.target.value)}
                  placeholder="原版转为版本，填版本名"
                  className="field flex-1"
                />
                <button
                  onClick={demoteMainTo}
                  disabled={busy || !demoteName.trim()}
                  className="whitespace-nowrap rounded-lg border border-stone-600 px-3 py-2 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50"
                >
                  转为版本
                </button>
              </div>
            )}
          </div>
        </details>

        {/* Metadata + danger zone — artist, renames, deletes */}
        <details className="rounded-lg border border-stone-800">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm text-stone-400 hover:text-stone-200">
            歌手 / 改名 / 删除
          </summary>
          <div className="flex flex-col gap-2 border-t border-stone-800 p-3">
            <div className="flex gap-2">
              <input
                value={artistValue}
                onChange={(e) => setArtistValue(e.target.value)}
                placeholder="歌手（留空清除）"
                className="field flex-1"
              />
              <button
                onClick={saveArtist}
                disabled={busy || artistValue.trim() === artist}
                className="whitespace-nowrap rounded-lg border border-stone-600 px-3 py-2 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50"
              >
                存歌手
              </button>
            </div>
            <div className="flex gap-2">
              <input
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                placeholder={`新歌名（当前：${name}）`}
                className="field flex-1"
              />
              <button
                onClick={doRenameSong}
                disabled={busy || !renameName.trim()}
                className="whitespace-nowrap rounded-lg border border-stone-600 px-3 py-2 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50"
              >
                改歌名
              </button>
            </div>
            {version && (
              <div className="flex gap-2">
                <input
                  value={renameVer}
                  onChange={(e) => setRenameVer(e.target.value)}
                  placeholder={`新版本名（当前：${version}）`}
                  className="field flex-1"
                />
                <button
                  onClick={doRenameVersion}
                  disabled={busy || !renameVer.trim()}
                  className="whitespace-nowrap rounded-lg border border-stone-600 px-3 py-2 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50"
                >
                  改版本名
                </button>
              </div>
            )}
            <button
              onClick={doDelete}
              disabled={busy}
              className="rounded-lg border border-red-800/60 bg-red-950/40 py-2 text-sm font-medium text-red-300 hover:bg-red-900/40 disabled:opacity-50"
            >
              {version ? `删除版本「${version}」` : `删除整首歌${hasVersions ? '（含所有版本）' : ''}`}
            </button>
          </div>
        </details>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <button
          onClick={close}
          disabled={busy}
          className="mt-3 w-full rounded-lg border border-stone-700 py-2 text-sm text-stone-300 hover:bg-stone-800 disabled:opacity-50"
        >
          关闭
        </button>
      </div>
    </div>,
    document.body
  )
}
