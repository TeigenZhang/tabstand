import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// ============================================================
// Thumbnail-proxy cache — fetch-once disk cache for remote tab-site
// cover/preview images. Keyed by sha256(url); the content-type is
// stored in a sidecar so the proxy serves the right MIME. Lives in the
// OS temp dir (regenerable, never committed). This is what bounds the
// proxy's outbound footprint: each remote image is pulled at most once,
// so a repeated search re-renders from disk, not from the source CDN.
// ============================================================

const CACHE_DIR = path.join(os.tmpdir(), 'tabstand-thumb-cache')

// Cap the cache so varying `?u=` can't fill the disk. Each entry is two
// files (bytes + `.type`); we count the bytes files. On overflow we evict
// oldest-by-mtime down to a low-water mark (a cheap approximate-LRU).
const MAX_ENTRIES = 500
const LOW_WATER = 400

export interface CachedThumb {
  data: Buffer
  contentType: string
}

export function thumbKey(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex')
}

export function readThumbCache(key: string): CachedThumb | null {
  try {
    const data = fs.readFileSync(path.join(CACHE_DIR, key))
    const contentType = fs.readFileSync(path.join(CACHE_DIR, `${key}.type`), 'utf-8')
    return { data, contentType }
  } catch {
    return null // miss (or unreadable) — caller fetches fresh
  }
}

export function writeThumbCache(key: string, thumb: CachedThumb): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(path.join(CACHE_DIR, key), thumb.data)
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.type`), thumb.contentType)
    pruneThumbCache()
  } catch {
    // Best-effort cache: a write failure just means the next hit re-fetches
  }
}

// Evict oldest entries when the cache grows past MAX_ENTRIES. Runs only on
// a write (cache miss), and the dir is bounded, so the readdir+stat is cheap.
function pruneThumbCache(): void {
  let keys: string[]
  try {
    keys = fs.readdirSync(CACHE_DIR).filter((f) => !f.endsWith('.type'))
  } catch {
    return
  }
  if (keys.length <= MAX_ENTRIES) return
  const byAge = keys
    .map((k) => {
      let mtime = 0
      try {
        mtime = fs.statSync(path.join(CACHE_DIR, k)).mtimeMs
      } catch {
        // missing/racing entry sorts oldest so it's pruned first
      }
      return { k, mtime }
    })
    .sort((a, b) => a.mtime - b.mtime)
  for (const { k } of byAge.slice(0, keys.length - LOW_WATER)) {
    fs.rmSync(path.join(CACHE_DIR, k), { force: true })
    fs.rmSync(path.join(CACHE_DIR, `${k}.type`), { force: true })
  }
}
