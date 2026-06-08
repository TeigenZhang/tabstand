import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// ============================================================
// Shared library-filesystem primitives — path safety, image
// listing, sequential renumbering, soft-delete trash, manifest
// rescan. Used by both the import pipeline (importServer) and
// the in-place edit ops (libraryEdit).
// ============================================================

export const LIBRARY_DIR = path.join(process.cwd(), 'library')
export const TRASH_DIR = path.join(LIBRARY_DIR, '.trash')
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|jfif|webp)$/i

const CATEGORIES = new Set(['strumming', 'fingerstyle'])
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000 // deleted pages stay recoverable for 7 days

// Reject anything that could escape a directory. User-supplied
// song/version names and staging ids all pass through here.
export function safeSegment(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (
    !trimmed ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    trimmed.startsWith('.')
  ) {
    throw new Error(`非法名称：${value}`)
  }
  return trimmed
}

export function assertCategory(category: string): string {
  if (!CATEGORIES.has(category)) throw new Error(`非法分类：${category}`)
  return category
}

// Natural sort: '2.png' < '10.png'
export const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true })

export function listImages(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXT_RE.test(e.name))
    .map((e) => e.name)
    .sort(naturalCompare)
}

export function listSubdirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

// ------------------------------------------------------------
// Renumbering
// ------------------------------------------------------------

// Rename the given files (already inside dir) to 1..N in the given
// order. Two-phase: first to tmp names so a swap (1↔2) can't
// collide. Tmp names keep the image extension on purpose — if the
// process dies mid-way the pages stay visible (and recoverable)
// instead of silently vanishing from listings. The per-call nonce
// keeps a NEW renumber from colliding with (and overwriting) tmp
// leftovers from a previously crashed run — leftovers just list as
// pages and get folded back in.
export function renumberImages(dir: string, orderedFiles: string[]): void {
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const tmpPaths = orderedFiles.map((file, i) => {
    const tmp = path.join(
      dir,
      `tmp-renumber-${nonce}-${i + 1}${path.extname(file).toLowerCase()}`
    )
    fs.renameSync(path.join(dir, file), tmp)
    return tmp
  })
  const now = new Date()
  tmpPaths.forEach((tmp, i) => {
    const final = path.join(dir, `${i + 1}${path.extname(tmp)}`)
    fs.renameSync(tmp, final)
    // rename preserves mtime, but mtime is the ?v= cache key and the
    // same NAME may now hold a different page — touch so every
    // renumber invalidates the browser's image cache
    fs.utimesSync(final, now, now)
  })
}

// Move files (absolute paths, in order) into dir, numbered after
// whatever it already holds. Existing pages are renumbered first to
// close any gaps — appending after "1.png, 3.png" must not clobber
// 3.png.
export function appendImages(dir: string, files: string[]): void {
  fs.mkdirSync(dir, { recursive: true })
  renumberImages(dir, listImages(dir))
  const offset = listImages(dir).length
  const now = new Date()
  files.forEach((file, i) => {
    const final = path.join(dir, `${offset + i + 1}${path.extname(file).toLowerCase()}`)
    fs.renameSync(file, final)
    // rename preserves mtime, but mtime is the ?v= cache key — both
    // per-page URLs and the song-level rev (list cover) must change
    // when a path starts serving a different page (e.g. promote swaps
    // the main sheet wholesale). Touch, same as renumberImages.
    fs.utimesSync(final, now, now)
  })
}

// ------------------------------------------------------------
// Song metadata — <songDir>/meta.json holds song-level facts
// (artist, …). It lives inside the song dir so it follows the
// song through renames and rides along into the trash.
// ------------------------------------------------------------

export interface SongMeta {
  artist?: string
  /** Preferred display order of versions/<name> dirs; names not
   *  listed sort after these, naturally. First one is the song's
   *  default arrangement when the main sheet is empty. */
  versionOrder?: string[]
}

export function readSongMeta(songDir: string): SongMeta {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(songDir, 'meta.json'), 'utf-8')
    )
    return typeof meta === 'object' && meta !== null ? meta : {}
  } catch {
    return {} // missing or malformed → no metadata
  }
}

// Merge-write: only the provided keys change. Empty values (blank
// artist, empty order list) remove their key — that's how the UI
// clears them.
export function writeSongMeta(songDir: string, patch: SongMeta): void {
  const merged: SongMeta = { ...readSongMeta(songDir), ...patch }
  if (!merged.artist?.trim()) delete merged.artist
  else merged.artist = merged.artist.trim()

  const order = Array.isArray(merged.versionOrder)
    ? merged.versionOrder.filter((v) => typeof v === 'string' && v.trim())
    : []
  if (order.length === 0) delete merged.versionOrder
  else merged.versionOrder = Array.from(new Set(order))

  const file = path.join(songDir, 'meta.json')
  if (Object.keys(merged).length === 0) {
    fs.rmSync(file, { force: true })
    return
  }
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`)
}

// ------------------------------------------------------------
// Trash — deletions are moves into library/.trash/<stamp>-<label>/
// so a misclick can't destroy an irreplaceable scan. Buckets are
// swept by TTL on every edit operation.
// ------------------------------------------------------------

function trashBucket(label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(TRASH_DIR, `${stamp}-${label}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function trashFiles(label: string, files: string[]): void {
  if (files.length === 0) return
  const bucket = trashBucket(label)
  for (const file of files) {
    fs.renameSync(file, path.join(bucket, path.basename(file)))
  }
}

export function trashDir(label: string, dir: string): void {
  fs.renameSync(dir, path.join(trashBucket(label), path.basename(dir)))
}

export function sweepTrash(maxAgeMs = TRASH_TTL_MS): void {
  if (!fs.existsSync(TRASH_DIR)) return
  const now = Date.now()
  for (const entry of fs.readdirSync(TRASH_DIR)) {
    try {
      const p = path.join(TRASH_DIR, entry)
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
        fs.rmSync(p, { recursive: true, force: true })
      }
    } catch {
      // Concurrent removal / race — ignore
    }
  }
}

// ------------------------------------------------------------
// Manifest rescan
// ------------------------------------------------------------

// Refresh the manifest so library changes show up immediately.
// Use process.execPath (this node's absolute path), not 'node' —
// under launchd the PATH is minimal and 'node' may not resolve.
export function rescanManifest(): void {
  execFileSync(process.execPath, [path.join('scripts', 'scan.mjs')], { stdio: 'ignore' })
}
