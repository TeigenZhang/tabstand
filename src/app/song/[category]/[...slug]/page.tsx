import fs from 'node:fs'
import path from 'node:path'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { findSong, readManifest } from '@/lib/manifest'
import { LIBRARY_DIR } from '@/lib/libraryFs'
import SheetViewer from '@/components/SheetViewer'
import EditPanel from '@/components/EditPanel'

// ============================================================
// Song page. Routes:
//   /song/<category>/<name>                  → main arrangement
//   /song/<category>/<name>/v/<version>      → alternate version
// ============================================================

export const dynamic = 'force-dynamic'

interface Props {
  params: { category: string; slug: string[] }
}

export default function SongPage({ params }: Props) {
  const [rawName, versionMarker, rawVersion] = params.slug
  const name = decodeURIComponent(rawName ?? '')

  const manifest = readManifest()
  const song = findSong(manifest, params.category, name)
  if (!song) notFound()

  // Resolve which page set to show: main pages or a version's
  let pages = song.pages
  let versionName: string | null = null
  if (versionMarker === 'v' && rawVersion) {
    const version = song.versions.find(
      (v) => v.name === decodeURIComponent(rawVersion)
    )
    if (!version) notFound()
    pages = version.pages
    versionName = version.name
  }

  // Main sheet emptied out (e.g. split entirely into versions) but
  // versions remain → land on the first version instead of a blank
  if (!versionName && pages.length === 0 && song.versions.length > 0) {
    redirect(
      `/song/${song.category}/${encodeURIComponent(song.name)}/v/${encodeURIComponent(song.versions[0].name)}`
    )
  }

  const baseDir = versionName
    ? `${song.category}/${song.name}/versions/${versionName}`
    : `${song.category}/${song.name}`

  // mtime as a cache-buster: edits renumber files in place, so the
  // same URL can suddenly serve a different page — the version param
  // keeps the browser's 1h image cache honest
  const fileVersion = (p: string): number => {
    try {
      return Math.trunc(fs.statSync(path.join(LIBRARY_DIR, baseDir, p)).mtimeMs)
    } catch {
      return 0
    }
  }

  const encodedDir = baseDir.split('/').map(encodeURIComponent).join('/')
  const imageUrls = pages.map(
    (p) => `/api/img/${encodedDir}/${encodeURIComponent(p)}?v=${fileVersion(p)}`
  )

  return (
    <SheetViewer
      title={versionName ? `${song.name} · ${versionName}` : song.name}
      imageUrls={imageUrls}
      leading={
        <Link
          href="/"
          className="shrink-0 rounded-lg px-2 py-1 text-sm text-stone-400 transition-colors hover:bg-stone-800 hover:text-stone-100"
        >
          ← 列表
        </Link>
      }
      tabs={
        // Version switcher (only when alternates exist)
        song.versions.length > 0 ? (
          <nav className="flex min-w-0 shrink gap-1 overflow-x-auto">
            {song.pages.length > 0 && (
              <Link
                href={`/song/${song.category}/${encodeURIComponent(song.name)}`}
                className={`whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors ${
                  !versionName
                    ? 'bg-amber-500 text-stone-950'
                    : 'text-stone-400 hover:bg-stone-800'
                }`}
              >
                原版
              </Link>
            )}
            {song.versions.map((v) => (
              <Link
                key={v.name}
                href={`/song/${song.category}/${encodeURIComponent(song.name)}/v/${encodeURIComponent(v.name)}`}
                title={v.name}
                className={`max-w-36 truncate whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors ${
                  versionName === v.name
                    ? 'bg-amber-500 text-stone-950'
                    : 'text-stone-400 hover:bg-stone-800'
                }`}
              >
                {v.name}
              </Link>
            ))}
          </nav>
        ) : undefined
      }
      actions={
        <EditPanel
          category={song.category}
          name={song.name}
          artist={song.artist ?? ''}
          version={versionName}
          pages={pages.map((p, i) => ({ file: p, url: imageUrls[i] }))}
          hasVersions={song.versions.length > 0}
          versions={song.versions.map((v) => v.name)}
          mainPages={song.pages.length}
        />
      }
    />
  )
}
