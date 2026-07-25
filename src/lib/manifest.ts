import fs from 'node:fs'
import path from 'node:path'

// ============================================================
// Manifest access — server components read from disk on every
// request, so a re-scan takes effect without restarting dev
// ============================================================

export interface Version {
  name: string
  pages: string[]
}

export interface Song {
  rev: number // newest page mtime — cache-buster for cover/page URLs
  name: string // directory name — identity / URL slug
  title: string // human-facing name (meta.title || name)
  owner: string // 角色 — whose collection this song belongs to
  category: string
  categoryLabel: string
  pinyin: string
  initials: string
  artist: string // '' when unset
  artistPinyin: string
  artistInitials: string
  pages: string[]
  versions: Version[]
}

export interface Owner {
  name: string
  count: number
}

export interface Manifest {
  categories: { key: string; label: string }[]
  owners: Owner[]
  total: number
  songs: Song[]
}

const MANIFEST_FILE = path.join(process.cwd(), 'data', 'manifest.json')

const EMPTY: Manifest = { categories: [], owners: [], total: 0, songs: [] }

// A manifest on disk may predate a field (角色 was added later, and
// `npm start` serves whatever the last scan wrote). Reading is the one
// choke point every consumer goes through, so the shape is normalized
// here rather than defended against at each call site.
function normalize(raw: unknown): Manifest {
  if (typeof raw !== 'object' || raw === null) return EMPTY
  const m = raw as Partial<Manifest>
  const songs = Array.isArray(m.songs) ? m.songs : []
  const owners = Array.isArray(m.owners) ? m.owners : []
  return {
    categories: Array.isArray(m.categories) ? m.categories : [],
    // Pre-roles manifest: derive the roster from the songs themselves so
    // the filter still works before the next scan (usually empty → the
    // role UI stays hidden, which is the correct pre-roles behaviour).
    owners: owners.length > 0 ? owners : deriveOwners(songs),
    total: typeof m.total === 'number' ? m.total : songs.length,
    songs,
  }
}

function deriveOwners(songs: Song[]): Owner[] {
  const counts = new Map<string, number>()
  for (const s of songs) {
    const name = s.owner?.trim()
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return Array.from(counts, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')
  )
}

export function readManifest(): Manifest {
  try {
    return normalize(JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8')))
  } catch (error) {
    console.error('Failed to read manifest, run `npm run scan` first:', error)
    return EMPTY
  }
}

// Distinct artist names already in the library — folded into the
// title-parsing vocabulary so re-importing a known artist (even one
// not in the hardcoded ARTISTS table) prefills with high confidence.
export function libraryArtists(): string[] {
  const seen = new Set<string>()
  for (const s of readManifest().songs) {
    const a = s.artist?.trim()
    if (a) seen.add(a)
  }
  return Array.from(seen)
}

export function findSong(
  manifest: Manifest,
  category: string,
  name: string
): Song | undefined {
  return manifest.songs.find(
    (s) => s.category === category && s.name === name
  )
}
