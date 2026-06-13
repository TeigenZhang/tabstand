import type { Song } from '@/lib/manifest'

// ============================================================
// Song media helpers — derive cover image URL and page count
// from a manifest entry. Shared by the song grid and the
// "随便弹" mood picker so both render covers identically.
// ============================================================

const enc = (s: string) => encodeURIComponent(s)

// Cover = first page of the main arrangement, or the first
// version's first page for version-only songs. ?v= busts the 1h
// image cache when an edit rewrites pages behind stable names.
export function coverUrl(song: Song): string | null {
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

export function pageCount(song: Song): number {
  return song.pages.length || song.versions[0]?.pages.length || 0
}
