import fs from 'node:fs'
import path from 'node:path'
import { assertPublicHttpUrl, getImageSize } from '../../scripts/lib/grab-core.mjs'
import {
  IMAGE_EXT_RE,
  LIBRARY_DIR,
  appendImages,
  assertCategory,
  listImages,
  naturalCompare,
  rescanManifest,
  safeSegment,
  writeSongMeta,
} from './libraryFs'

// SSRF guard lives in grab-core (shared with the CLI); re-export so
// API routes can import it from the server module they already use
export { assertPublicHttpUrl }

// ============================================================
// Server-side import helpers: staging area + commit to library.
//
// Scraped/uploaded images land in library/.staging/<id>/ first so
// the user can preview and confirm before they become real songs.
// Committing renumbers them into the target song directory.
// ============================================================

export const STAGING_DIR = path.join(LIBRARY_DIR, '.staging')

// Upload guards — a self-hosted tool, but still don't let a request
// fill the disk or smuggle non-images in.
export const UPLOAD_LIMITS = {
  maxFiles: 40,
  maxFileBytes: 25 * 1024 * 1024, // 25MB per image
  maxTotalBytes: 150 * 1024 * 1024, // 150MB per upload
  maxPixels: 50_000_000, // ~decompression-bomb guard
}

const STAGING_TTL_MS = 6 * 60 * 60 * 1000 // orphaned sessions expire in 6h

// Thrown when a commit would mix pages into a song/version that
// already has pages — the UI turns this into an explicit choice
// (append / make it a version) instead of silently interleaving.
export class CommitConflictError extends Error {
  existingPages: number
  constructor(target: string, existingPages: number) {
    super(`「${target}」已有 ${existingPages} 页`)
    this.name = 'CommitConflictError'
    this.existingPages = existingPages
  }
}

// Identify an image by magic bytes — extension/MIME from the client
// can't be trusted. Returns the canonical extension or null.
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return '.webp'
  return null
}

// Validate an uploaded buffer: real image type + sane pixel count.
// Returns the canonical extension or throws.
export function validateUploadBuffer(buf: Buffer): string {
  const ext = sniffImageType(buf)
  if (!ext) throw new Error('不是有效的图片（仅支持 png/jpg/gif/webp）')
  if (buf.length > UPLOAD_LIMITS.maxFileBytes) throw new Error('单张图片过大')
  const size = getImageSize(buf)
  if (size && size.width * size.height > UPLOAD_LIMITS.maxPixels) {
    throw new Error('图片分辨率过大')
  }
  return ext
}

// ------------------------------------------------------------
// Staging
// ------------------------------------------------------------

export function stagingPath(id: string): string {
  return path.join(STAGING_DIR, safeSegment(id))
}

// Persist a list of image buffers to a fresh staging dir
export function writeStaging(
  id: string,
  images: { data: Buffer; ext: string }[]
): void {
  const dir = stagingPath(id)
  fs.mkdirSync(dir, { recursive: true })
  images.forEach((img, i) => {
    fs.writeFileSync(path.join(dir, `${i + 1}${img.ext}`), img.data)
  })
}

export interface StagedImage {
  file: string
  url: string
  width?: number
  height?: number
}

export function listStaging(id: string): StagedImage[] {
  const dir = stagingPath(id)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => IMAGE_EXT_RE.test(f))
    .sort(naturalCompare)
    .map((file) => {
      const size = getImageSize(fs.readFileSync(path.join(dir, file)))
      return {
        file,
        url: `/api/img/.staging/${encodeURIComponent(id)}/${encodeURIComponent(file)}`,
        width: size?.width,
        height: size?.height,
      }
    })
}

export function cleanupStaging(id: string): void {
  fs.rmSync(stagingPath(id), { recursive: true, force: true })
}

// Remove staging sessions the user abandoned (closed the tab without
// committing or discarding). Called when a new session is created.
export function sweepStaging(maxAgeMs = STAGING_TTL_MS): void {
  if (!fs.existsSync(STAGING_DIR)) return
  const now = Date.now()
  for (const entry of fs.readdirSync(STAGING_DIR)) {
    try {
      const p = path.join(STAGING_DIR, entry)
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
        fs.rmSync(p, { recursive: true, force: true })
      }
    } catch {
      // Concurrent removal / race — ignore
    }
  }
}

// ------------------------------------------------------------
// Commit: move staged images into the library
// ------------------------------------------------------------

// Pick a fresh, path-safe directory name for a NEW song whose title
// collides with one already in the library — the same-title /
// different-artist case (《姑娘》by 陈楚生 vs 隔壁老樊). Prefers
//「<title> (<artist>)」, falls back to「<title> (2)」, (3)…. The
// clean title is preserved separately in meta.title.
function uniqueSongDir(category: string, title: string, artist?: string): string {
  const exists = (dirName: string) =>
    fs.existsSync(path.join(LIBRARY_DIR, category, dirName))

  if (!exists(title)) return title

  const a = artist?.trim()
  if (a) {
    const withArtist = `${title} (${a})`
    // The artist is free-form content; only use it as a path segment
    // when it's actually safe (no slashes / dot-prefix / ..)
    try {
      safeSegment(withArtist)
      if (!exists(withArtist)) return withArtist
    } catch {
      // fall through to the numeric scheme
    }
  }

  for (let i = 2; i < 1000; i++) {
    const cand = `${title} (${i})`
    if (!exists(cand)) return cand
  }
  throw new Error('无法为同名歌生成唯一目录，名字太多了')
}

export function commitStaging(opts: {
  id: string
  category: string
  name: string
  version?: string
  artist?: string // song-level metadata, written to <songDir>/meta.json
  owner?: string // 角色 — whose collection (blank → primary user)
  files?: string[] // whitelist of staged filenames to keep (default: all)
  // 'append' — consent to add after an existing song's pages.
  // 'newsong' — a distinct song that happens to share the title;
  //   lands in a disambiguated dir with the clean title in meta.json.
  mode?: 'append' | 'newsong'
}): { targetDir: string; count: number; rescanned: boolean } {
  const category = assertCategory(opts.category)
  const title = safeSegment(opts.name) // typed name = display title
  const version = opts.version ? safeSegment(opts.version) : null

  const source = stagingPath(opts.id)
  // Idempotency: a committed/expired session has no dir, so a double
  // submit (double-click, refresh, second tab) can't create duplicates
  if (!fs.existsSync(source)) {
    throw new Error('暂存已失效（可能已入库或超时清理），请重新抓取或上传')
  }

  const available = new Set(
    fs.readdirSync(source).filter((f) => IMAGE_EXT_RE.test(f))
  )

  // Order + selection come from the preview: opts.files is the chosen
  // pages IN DISPLAY ORDER. Filter against the staging set so the
  // request body can't reference arbitrary paths, and keep its order.
  let staged: string[]
  if (opts.files && opts.files.length > 0) {
    staged = opts.files.filter((f) => available.has(f))
  } else {
    staged = Array.from(available).sort(naturalCompare)
  }
  if (staged.length === 0) throw new Error('没有选中任何页，无法入库')

  // 'newsong' forces a distinct song even though the title collides —
  // a separate dir (disambiguated), main sheet only (a brand-new song
  // doesn't start life as someone else's version).
  const isNewSong = opts.mode === 'newsong'
  const dirName = isNewSong ? uniqueSongDir(category, title, opts.artist) : title
  const songDir = path.join(LIBRARY_DIR, category, dirName)
  const targetDir = version && !isNewSong ? path.join(songDir, 'versions', version) : songDir

  // The target already has pages → don't silently interleave two
  // arrangements (the 漠河舞厅 incident). The UI offers an explicit
  // choice: append anyway, commit under a version name, or — for a
  // same-title-different-song — land it as 另一首歌 ('newsong').
  const existingPages = listImages(targetDir).length
  if (existingPages > 0 && opts.mode !== 'append' && !isNewSong) {
    throw new CommitConflictError(version ? `${title} · ${version}` : title, existingPages)
  }

  // Whether a REAL song already lived here BEFORE this commit — decides
  // whether owner may be written (see below). Keyed off actual page
  // content (main sheet or a version that HAS pages) plus a saved
  // meta.json — never bare dir existence. An empty leftover dir, or an
  // empty versions/<name>/ a prior failed commit created, must NOT read
  // as "existing" and rob a new song of its chosen owner on retry. A
  // disambiguated 'newsong' dir is fresh by construction.
  const hasPagesAnywhere = (dir: string): boolean => {
    if (listImages(dir).length > 0) return true
    const vd = path.join(dir, 'versions')
    if (!fs.existsSync(vd)) return false
    return fs
      .readdirSync(vd, { withFileTypes: true })
      .some((e) => e.isDirectory() && listImages(path.join(vd, e.name)).length > 0)
  }
  const songExisted =
    !isNewSong &&
    (hasPagesAnywhere(songDir) || fs.existsSync(path.join(songDir, 'meta.json')))

  // Filesystem commits aren't transactional. The invariant we hold: once
  // the staging session is CONSUMED it can never be committed again, so no
  // failure (or double-submit, or failed cleanup) can produce a duplicate.
  //
  // NEW song: first CLAIM the session with an atomic rename — the moment it
  //   succeeds the session id is gone, so any resubmit hits '暂存已失效'.
  //   Then assemble the whole song (pages renumbered + meta.json) in a build
  //   dir and land it with a second atomic rename: pages and owner appear
  //   together or not at all. Claiming up front trades retryability for
  //   idempotency on purpose — a rare mid-assembly failure means re-scrape,
  //   which is far better than a silently duplicated or misfiled song.
  // EXISTING song (append / add-version): appendImages MOVES pages out of
  //   the session (consuming it), then artist is updated if given. Owner is
  //   never rewritten, so the form default can't hijack an owned song;
  //   role reassignment goes through the edit op.
  if (!songExisted) {
    const claimDir = path.join(STAGING_DIR, `.claim-${safeSegment(opts.id)}`)
    const buildDir = path.join(STAGING_DIR, `.build-${safeSegment(opts.id)}`)
    const relTarget = version && !isNewSong ? path.join('versions', version) : '.'
    fs.rmSync(claimDir, { recursive: true, force: true }) // clear a prior aborted attempt
    fs.renameSync(source, claimDir) // CLAIM: session id no longer exists → no re-commit
    try {
      fs.rmSync(buildDir, { recursive: true, force: true })
      const pagesDir = path.join(buildDir, relTarget)
      fs.mkdirSync(pagesDir, { recursive: true })
      // Move the selected pages into place, renumbered in display order.
      staged.forEach((file, i) => {
        const ext = path.extname(file).toLowerCase()
        fs.renameSync(path.join(claimDir, file), path.join(pagesDir, `${i + 1}${ext}`))
      })
      // meta.json is built INSIDE the build dir so it lands atomically with
      // the pages. title only when the dir was disambiguated; artist/owner
      // only when provided (the form always sends owner for a shared library).
      const meta: { title?: string; artist?: string; owner?: string } = {}
      if (dirName !== title) meta.title = title
      if (typeof opts.artist === 'string' && opts.artist.trim()) meta.artist = opts.artist.trim()
      if (typeof opts.owner === 'string' && opts.owner.trim()) meta.owner = opts.owner.trim()
      if (Object.keys(meta).length > 0) {
        fs.writeFileSync(path.join(buildDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
      }
      // Land it atomically. Any empty leftover dir (songExisted is false, so
      // it holds no real content) is cleared first so rename can't ENOTEMPTY.
      fs.mkdirSync(path.dirname(songDir), { recursive: true })
      fs.rmSync(songDir, { recursive: true, force: true })
      fs.renameSync(buildDir, songDir)
    } catch (err) {
      fs.rmSync(buildDir, { recursive: true, force: true })
      throw err
    } finally {
      // Post-commit housekeeping: dropping leftovers must never throw out of
      // a landed commit (nor mask a pre-commit error being rethrown above).
      try {
        fs.rmSync(claimDir, { recursive: true, force: true }) // non-selected leftovers
      } catch {
        // swept by the staging TTL if it lingers
      }
    }
  } else {
    appendImages(targetDir, staged.map((file) => path.join(source, file)))
    // Artist is song-level — write only when the user typed one, so an
    // append can't blank existing meta. Owner stays as-is (preserved).
    if (typeof opts.artist === 'string' && opts.artist.trim()) {
      writeSongMeta(songDir, { artist: opts.artist })
    }
    // Post-commit: draining the session must not fail an already-appended song
    try {
      cleanupStaging(opts.id)
    } catch {
      // swept by the staging TTL if it lingers
    }
  }

  // The song is now durably in place — the commit has SUCCEEDED. The manifest
  // is a derived cache: a refresh failure must neither abort the commit
  // (mislabeling a landed song as failed) nor be hidden (masking a stale
  // manifest as clean success). Report it as a flag. A retry is safe anyway —
  // the session is consumed, so it resolves to '暂存已失效', never a duplicate.
  let rescanned = true
  try {
    rescanManifest()
  } catch {
    rescanned = false
  }

  return { targetDir: path.relative(process.cwd(), targetDir), count: staged.length, rescanned }
}
