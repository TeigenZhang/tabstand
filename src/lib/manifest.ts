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

export interface Manifest {
  categories: { key: string; label: string }[]
  total: number
  songs: Song[]
}

const MANIFEST_FILE = path.join(process.cwd(), 'data', 'manifest.json')

export function readManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8'))
  } catch (error) {
    console.error('Failed to read manifest, run `npm run scan` first:', error)
    return { categories: [], total: 0, songs: [] }
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
