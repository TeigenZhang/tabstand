import fs from 'node:fs'
import path from 'node:path'
import {
  LIBRARY_DIR,
  appendImages,
  assertCategory,
  listImages,
  listSubdirs,
  readSongMeta,
  renumberImages,
  rescanManifest,
  safeSegment,
  sweepTrash,
  trashDir,
  trashFiles,
  writeSongMeta,
} from './libraryFs'

// ============================================================
// Library edit ops — everything the UI can do to songs already
// in the library: reorder/delete pages, move pages between the
// main sheet and versions, rename, delete. Every destructive
// path goes through the trash (soft delete, 7-day TTL), and
// every op ends with a manifest rescan.
// ============================================================

const VERSIONS = 'versions'

// Thrown when a page move targets a version/main dir that already
// has pages — the UI confirms before merging, mirroring the import
// 409 flow, so two arrangements can't silently interleave.
export class MoveConflictError extends Error {
  existingPages: number
  constructor(target: string, existingPages: number) {
    super(`「${target}」已有 ${existingPages} 页`)
    this.name = 'MoveConflictError'
    this.existingPages = existingPages
  }
}

// Resolve a song's page directory (main or a version's)
function pageDir(category: string, name: string, version?: string | null): string {
  const dir = path.join(LIBRARY_DIR, assertCategory(category), safeSegment(name))
  return version ? path.join(dir, VERSIONS, safeSegment(version)) : dir
}

function assertExists(dir: string): void {
  if (!fs.existsSync(dir)) {
    throw new Error('找不到这首歌（或版本），可能已被改动，请刷新页面')
  }
}

// Validate a client-supplied file list against what's really in the
// dir — the request body can't reference arbitrary paths. Keeps the
// request order (= display order), drops duplicates.
function pickExisting(dir: string, files: string[]): string[] {
  const available = new Set(listImages(dir))
  return Array.from(new Set(files.filter((f) => available.has(f))))
}

// Trash bucket label like "strumming-漠河舞厅" / "strumming-漠河舞厅-弹手吉他"
function trashLabel(category: string, name: string, version?: string | null): string {
  return [category, name, version].filter(Boolean).join('-')
}

// On the default case-insensitive macOS volume, a case-only rename
// ("hotel california" → "Hotel California") makes existsSync(to)
// resolve to the SOURCE dir — that's not a conflict. Compare inodes
// to tell "same directory under another spelling" from a real clash.
function isSameDir(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    return sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}

// Drop now-empty version dirs / the versions container / the song
// dir itself so emptied-out shells don't linger in the library
function pruneEmptyDirs(category: string, name: string): void {
  const songDir = pageDir(category, name)
  if (!fs.existsSync(songDir)) return
  const versionsDir = path.join(songDir, VERSIONS)
  for (const v of listSubdirs(versionsDir)) {
    const dir = path.join(versionsDir, v)
    if (listImages(dir).length === 0 && listSubdirs(dir).length === 0) {
      fs.rmSync(dir, { recursive: true, force: true }) // only stray junk like .DS_Store left
    }
  }
  if (fs.existsSync(versionsDir) && listSubdirs(versionsDir).length === 0) {
    fs.rmSync(versionsDir, { recursive: true, force: true })
  }
  if (listImages(songDir).length === 0 && listSubdirs(songDir).length === 0) {
    fs.rmSync(songDir, { recursive: true, force: true })
  }
}

// Rewrite meta.versionOrder through a pure transform — rename /
// delete / promote keep the saved order in sync with the dirs
function updateVersionOrder(
  songDir: string,
  fn: (order: string[]) => string[]
): void {
  if (!fs.existsSync(songDir)) return
  const order = readSongMeta(songDir).versionOrder ?? []
  writeSongMeta(songDir, { versionOrder: fn(order) })
}

// The order the UI actually displays: saved names first (validated
// against the real dirs), the rest natural-sorted — the exact rule
// scan.mjs applies. Ops that edit "the displayed slot" must start
// from this, not from the (possibly empty) saved list.
function effectiveVersionOrder(songDir: string): string[] {
  const real = listSubdirs(path.join(songDir, VERSIONS))
  const realSet = new Set(real)
  const saved = (readSongMeta(songDir).versionOrder ?? []).filter((v) =>
    realSet.has(v)
  )
  const savedSet = new Set(saved)
  const rest = real
    .filter((v) => !savedSet.has(v))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
  return [...saved, ...rest]
}

// Does the song still exist (main pages or any version with pages)?
function songRemains(category: string, name: string): boolean {
  const songDir = pageDir(category, name)
  if (!fs.existsSync(songDir)) return false
  if (listImages(songDir).length > 0) return true
  const versionsDir = path.join(songDir, VERSIONS)
  return listSubdirs(versionsDir).some(
    (v) => listImages(path.join(versionsDir, v)).length > 0
  )
}

// Common tail for every op: prune shells, sweep the trash, rescan
function finalize(category: string, name: string): void {
  pruneEmptyDirs(category, name)
  sweepTrash()
  rescanManifest()
}

// ------------------------------------------------------------
// Page-level ops
// ------------------------------------------------------------

// Apply the edited page set: `keep` is the surviving filenames in
// display order; everything else in the dir goes to the trash.
export function applyPageEdit(opts: {
  category: string
  name: string
  version?: string | null
  keep: string[]
}): { kept: number; removed: number; songRemains: boolean } {
  const dir = pageDir(opts.category, opts.name, opts.version)
  assertExists(dir)
  const keep = pickExisting(dir, opts.keep)
  const keepSet = new Set(keep)
  const removed = listImages(dir).filter((f) => !keepSet.has(f))

  trashFiles(
    trashLabel(opts.category, opts.name, opts.version),
    removed.map((f) => path.join(dir, f))
  )
  renumberImages(dir, keep)
  finalize(opts.category, opts.name)
  return {
    kept: keep.length,
    removed: removed.length,
    songRemains: songRemains(opts.category, opts.name),
  }
}

// Move pages between the main sheet and a version (either way).
// toVersion === null moves into the main directory. The moved pages
// are appended after whatever the target already holds; both sides
// are renumbered (the source honoring sourceOrder when given). This
// is the "split a mixed-up song" op.
export function movePages(opts: {
  category: string
  name: string
  fromVersion?: string | null
  toVersion: string | null
  files: string[]
  sourceOrder?: string[] // display order for the pages staying behind
  merge?: boolean // explicit consent to append into a non-empty target
}): { moved: number } {
  const from = opts.fromVersion ?? null
  const to = opts.toVersion ?? null
  if (from === to) throw new Error('目标和来源相同')

  const fromDir = pageDir(opts.category, opts.name, from)
  assertExists(fromDir)
  const files = pickExisting(fromDir, opts.files)
  if (files.length === 0) throw new Error('没有选中任何页')

  // A non-empty target needs explicit consent — typing the name of
  // an EXISTING version must not silently merge two arrangements
  const toDir = pageDir(opts.category, opts.name, to)
  const targetPages = listImages(toDir).length
  if (targetPages > 0 && opts.merge !== true) {
    throw new MoveConflictError(to ?? '主谱', targetPages)
  }

  appendImages(toDir, files.map((f) => path.join(fromDir, f)))

  // Renumber what stayed behind: requested order first, then any
  // stragglers the client didn't mention, in natural order
  const ordered = pickExisting(fromDir, opts.sourceOrder ?? [])
  const orderedSet = new Set(ordered)
  const stragglers = listImages(fromDir).filter((f) => !orderedSet.has(f))
  renumberImages(fromDir, [...ordered, ...stragglers])

  finalize(opts.category, opts.name)
  return { moved: files.length }
}

// ------------------------------------------------------------
// Metadata
// ------------------------------------------------------------

// Set / clear the song's artist ('' clears). No safeSegment here —
// the artist is file CONTENT (meta.json), not a path segment.
export function setArtist(opts: {
  category: string
  name: string
  artist: string
}): { artist: string } {
  const dir = pageDir(opts.category, opts.name)
  assertExists(dir)
  const artist = typeof opts.artist === 'string' ? opts.artist.trim() : ''
  writeSongMeta(dir, { artist })
  rescanManifest()
  return { artist }
}

// ------------------------------------------------------------
// Version management — display order, and swapping what counts
// as the "main" arrangement
// ------------------------------------------------------------

// Persist the preferred display order. Names are validated against
// the real version dirs; the first entry becomes the cover/default
// for version-only songs.
export function reorderVersions(opts: {
  category: string
  name: string
  order: string[]
}): { order: string[] } {
  const songDir = pageDir(opts.category, opts.name)
  assertExists(songDir)
  const real = new Set(listSubdirs(path.join(songDir, VERSIONS)))
  const order = Array.from(
    new Set(
      (Array.isArray(opts.order) ? opts.order : []).filter(
        (v) => typeof v === 'string' && real.has(v)
      )
    )
  )
  writeSongMeta(songDir, { versionOrder: order })
  rescanManifest()
  return { order }
}

// Turn the main sheet into a named version (the song becomes
// version-only). This is how a mislabeled "默认" gets a real name.
export function demoteMain(opts: {
  category: string
  name: string
  toVersion: string
}): { version: string } {
  const songDir = pageDir(opts.category, opts.name)
  assertExists(songDir)
  const mainPages = listImages(songDir)
  if (mainPages.length === 0) throw new Error('主谱没有页，无需转换')

  const target = safeSegment(opts.toVersion)
  const targetDir = pageDir(opts.category, opts.name, target)
  if (fs.existsSync(targetDir)) {
    throw new Error(`已存在同名版本「${target}」，换个名字`)
  }

  // Displayed order before the new dir appears in listings
  const displayOrder = effectiveVersionOrder(songDir)
  appendImages(targetDir, mainPages.map((f) => path.join(songDir, f)))
  // The demoted main keeps its "default arrangement" status — first
  // slot, with the rest of the displayed order frozen behind it
  updateVersionOrder(songDir, () => [
    target,
    ...displayOrder.filter((v) => v !== target),
  ])
  finalize(opts.category, opts.name)
  return { version: target }
}

// Make a version the main arrangement. If the main sheet has pages
// they must be demoted to a version first — demoteTo names it (the
// two sets swap places); with an empty main the version just moves.
export function promoteVersion(opts: {
  category: string
  name: string
  version: string
  demoteTo?: string | null
}): { demoted: string | null } {
  const songDir = pageDir(opts.category, opts.name)
  const versionName = safeSegment(opts.version)
  const versionDir = pageDir(opts.category, opts.name, versionName)
  assertExists(versionDir)
  const versionPages = listImages(versionDir)
  if (versionPages.length === 0) throw new Error('该版本没有页')

  // Snapshot the DISPLAYED order before any dirs move — with no
  // saved order this is the natural sort the tabs actually show
  const displayOrder = effectiveVersionOrder(songDir)

  const mainPages = listImages(songDir)
  let demoted: string | null = null
  if (mainPages.length > 0) {
    if (!opts.demoteTo?.trim()) {
      throw new Error('主谱已有页，需要先给它填一个版本名')
    }
    demoted = safeSegment(opts.demoteTo)
    if (demoted === versionName) {
      throw new Error('新版本名不能与被设为默认的版本同名')
    }
    const demotedDir = pageDir(opts.category, opts.name, demoted)
    if (fs.existsSync(demotedDir)) {
      throw new Error(`已存在同名版本「${demoted}」，换个名字`)
    }
    appendImages(demotedDir, mainPages.map((f) => path.join(songDir, f)))
  }

  appendImages(songDir, versionPages.map((f) => path.join(versionDir, f)))

  // Order bookkeeping: the demoted main inherits the promoted
  // version's displayed slot, so the swap is invisible to the tabs
  updateVersionOrder(songDir, () => {
    const next = displayOrder.slice()
    const i = next.indexOf(versionName)
    if (demoted) {
      if (i >= 0) next.splice(i, 1, demoted)
      else next.unshift(demoted)
    } else if (i >= 0) {
      next.splice(i, 1)
    }
    return next
  })

  finalize(opts.category, opts.name)
  return { demoted }
}

// ------------------------------------------------------------
// Rename / delete
// ------------------------------------------------------------

export function renameSong(opts: {
  category: string
  name: string
  newName: string
}): { newName: string } {
  const from = pageDir(opts.category, opts.name)
  assertExists(from)
  const newName = safeSegment(opts.newName)
  const to = pageDir(opts.category, newName)
  if (from !== to && fs.existsSync(to) && !isSameDir(from, to)) {
    throw new Error(`已存在同名歌「${newName}」`)
  }
  fs.renameSync(from, to)
  rescanManifest()
  return { newName }
}

export function renameVersion(opts: {
  category: string
  name: string
  version: string
  newVersion: string
}): { newVersion: string } {
  const from = pageDir(opts.category, opts.name, opts.version)
  assertExists(from)
  const newVersion = safeSegment(opts.newVersion)
  const to = pageDir(opts.category, opts.name, newVersion)
  if (from !== to && fs.existsSync(to) && !isSameDir(from, to)) {
    throw new Error(`已存在同名版本「${newVersion}」`)
  }
  fs.renameSync(from, to)
  updateVersionOrder(pageDir(opts.category, opts.name), (order) =>
    order.map((v) => (v === opts.version ? newVersion : v))
  )
  rescanManifest()
  return { newVersion }
}

export function deleteSong(opts: { category: string; name: string }): void {
  const dir = pageDir(opts.category, opts.name)
  assertExists(dir)
  trashDir(trashLabel(opts.category, opts.name), dir)
  sweepTrash()
  rescanManifest()
}

export function deleteVersion(opts: {
  category: string
  name: string
  version: string
}): { songRemains: boolean } {
  const dir = pageDir(opts.category, opts.name, opts.version)
  assertExists(dir)
  updateVersionOrder(pageDir(opts.category, opts.name), (order) =>
    order.filter((v) => v !== opts.version)
  )
  trashDir(trashLabel(opts.category, opts.name, opts.version), dir)
  finalize(opts.category, opts.name)
  return { songRemains: songRemains(opts.category, opts.name) }
}
