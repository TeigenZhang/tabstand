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

export function commitStaging(opts: {
  id: string
  category: string
  name: string
  version?: string
  artist?: string // song-level metadata, written to <songDir>/meta.json
  files?: string[] // whitelist of staged filenames to keep (default: all)
  mode?: 'append' // explicit consent to add after an existing song's pages
}): { targetDir: string; count: number } {
  const category = assertCategory(opts.category)
  const name = safeSegment(opts.name)
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

  const songDir = path.join(LIBRARY_DIR, category, name)
  const targetDir = version ? path.join(songDir, 'versions', version) : songDir

  // The target already has pages → don't silently interleave two
  // arrangements (the 漠河舞厅 incident). The UI offers an explicit
  // choice: append anyway, or commit under a version name.
  const existingPages = listImages(targetDir).length
  if (existingPages > 0 && opts.mode !== 'append') {
    throw new CommitConflictError(version ? `${name} · ${version}` : name, existingPages)
  }

  appendImages(targetDir, staged.map((file) => path.join(source, file)))

  // Artist is song-level (not per version) — write it only when the
  // user actually typed one, so re-imports can't blank existing meta
  if (typeof opts.artist === 'string' && opts.artist.trim()) {
    writeSongMeta(songDir, { artist: opts.artist })
  }
  cleanupStaging(opts.id)

  // Refresh the manifest so the new song shows up immediately
  rescanManifest()

  return { targetDir: path.relative(process.cwd(), targetDir), count: staged.length }
}
