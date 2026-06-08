// ============================================================
// scan.mjs — scan library/ and generate data/manifest.json
// Usage: npm run scan (runs automatically before dev/build)
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { pinyin } from 'pinyin-pro'

const ROOT = process.cwd()
const LIBRARY_DIR = path.join(ROOT, 'library')
const OUTPUT_FILE = path.join(ROOT, 'data', 'manifest.json')

const CATEGORIES = [
  { key: 'strumming', label: '弹唱' },
  { key: 'fingerstyle', label: '指弹' },
]

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.jfif', '.webp'])
const VERSIONS_DIR = 'versions'

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

// Natural sort: '2.png' < '10.png'
const naturalCompare = (a, b) =>
  a.localeCompare(b, 'zh-CN', { numeric: true })

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// Full pinyin: 南方姑娘 → nanfangguniang; ASCII passes through
const toFullPinyin = (name) =>
  normalize(pinyin(name, { toneType: 'none', type: 'array' }).join(''))

// Initials: 南方姑娘 → nfgn
const toInitials = (name) =>
  normalize(
    pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' }).join('')
  )

const listImages = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())
    )
    .map((e) => e.name)
    .sort(naturalCompare)

// Newest mtime across a set of pages — edits renumber files in place
// (same name, new content), so the manifest carries a revision the
// UI appends as ?v= to keep the 1h image cache honest
const maxMtime = (dir, files) =>
  files.reduce((max, f) => {
    try {
      return Math.max(max, Math.trunc(fs.statSync(path.join(dir, f)).mtimeMs))
    } catch {
      return max
    }
  }, 0)

const listSubdirs = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

// Song-level metadata (artist, …) lives in <songDir>/meta.json —
// it travels with the song through renames and deletions
const readMeta = (songDir) => {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(songDir, 'meta.json'), 'utf-8')
    )
    return typeof meta === 'object' && meta !== null ? meta : {}
  } catch {
    return {} // missing or malformed → no metadata
  }
}

// ------------------------------------------------------------
// Scan one category directory
// ------------------------------------------------------------
function scanCategory({ key, label }) {
  const categoryDir = path.join(LIBRARY_DIR, key)
  if (!fs.existsSync(categoryDir)) return []

  return listSubdirs(categoryDir)
    .map((songName) => {
      const songDir = path.join(categoryDir, songName)
      const pages = listImages(songDir)

      // versions/<name>/ subdirectories → alternate arrangements
      const versionsDir = path.join(songDir, VERSIONS_DIR)
      const versions = fs.existsSync(versionsDir)
        ? listSubdirs(versionsDir)
            .map((versionName) => ({
              name: versionName,
              pages: listImages(path.join(versionsDir, versionName)),
            }))
            .filter((v) => v.pages.length > 0)
        : []

      const meta = readMeta(songDir)
      const artist = typeof meta.artist === 'string' ? meta.artist.trim() : ''

      // meta.versionOrder pins the display order: listed names first
      // (in that order), unlisted ones after, natural-sorted. The
      // first version doubles as cover / default open for songs
      // whose main sheet is empty.
      const orderList = Array.isArray(meta.versionOrder) ? meta.versionOrder : []
      versions.sort((a, b) => {
        const ia = orderList.indexOf(a.name)
        const ib = orderList.indexOf(b.name)
        if (ia >= 0 && ib >= 0) return ia - ib
        if (ia >= 0) return -1
        if (ib >= 0) return 1
        return naturalCompare(a.name, b.name)
      })

      // Song revision: newest page mtime across main + all versions
      // (the list cover may come from either)
      const rev = Math.max(
        maxMtime(songDir, pages),
        ...versions.map((v) =>
          maxMtime(path.join(versionsDir, v.name), v.pages)
        ),
        0
      )

      return {
        rev,
        name: songName,
        category: key,
        categoryLabel: label,
        pinyin: toFullPinyin(songName),
        initials: toInitials(songName),
        artist,
        artistPinyin: artist ? toFullPinyin(artist) : '',
        artistInitials: artist ? toInitials(artist) : '',
        pages,
        versions,
      }
    })
    .filter((song) => song.pages.length > 0 || song.versions.length > 0)
}

// ------------------------------------------------------------
// Ordering: English titles first (alphabetical), then Chinese
// by pinyin — same convention as scripts/get_pdf.py
// ------------------------------------------------------------
function sortSongs(songs) {
  const isAscii = (s) => s.charCodeAt(0) < 128
  const english = songs
    .filter((s) => isAscii(s.name))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  const chinese = songs
    .filter((s) => !isAscii(s.name))
    .sort((a, b) => a.pinyin.localeCompare(b.pinyin))
  return [...english, ...chinese]
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
const songs = CATEGORIES.flatMap((category) =>
  sortSongs(scanCategory(category))
)

const manifest = {
  categories: CATEGORIES,
  total: songs.length,
  songs,
}

// Atomic write: a concurrent reader (the running web app) never sees
// a half-written manifest — write a temp file, then rename over.
fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true })
const tmpFile = `${OUTPUT_FILE}.${process.pid}.tmp`
fs.writeFileSync(tmpFile, JSON.stringify(manifest, null, 2))
fs.renameSync(tmpFile, OUTPUT_FILE)

const counts = CATEGORIES.map(
  ({ key, label }) =>
    `${label} ${songs.filter((s) => s.category === key).length} 首`
).join('，')
console.log(`manifest 已生成：${counts}，共 ${songs.length} 首`)
