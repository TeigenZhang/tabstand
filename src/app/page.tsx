import { readManifest } from '@/lib/manifest'
import SongList from '@/components/SongList'
import ImportPanel from '@/components/ImportPanel'
import { SOURCE_LIST } from '../../scripts/lib/search-sources.mjs'

// Manifest is read per-request; a re-scan only needs a page refresh
export const dynamic = 'force-dynamic'

export default function HomePage() {
  const manifest = readManifest()

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-8 flex items-end justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-2xl shadow-lg shadow-amber-900/50 ring-1 ring-inset ring-white/20">
            🎸
          </span>
          <div>
            <h1 className="font-display text-3xl font-bold tracking-wide sm:text-4xl">
              吉他谱
            </h1>
            <p className="mt-1 flex items-center gap-2 text-sm text-stone-400">
              <span className="font-tuner text-amber-400/90">{manifest.total}</span>
              首
              <span className="text-stone-600">·</span>
              拼音速搜
              <span className="text-stone-600">·</span>
              多列看谱
              <span className="hidden text-stone-600 sm:inline">·</span>
              <span className="hidden sm:inline">踏板翻页</span>
            </p>
          </div>
        </div>
        <ImportPanel
          categories={manifest.categories}
          sources={SOURCE_LIST}
          songs={manifest.songs.map((s) => ({
            category: s.category,
            name: s.name,
            title: s.title,
            pages: s.pages.length,
            versions: s.versions.length,
          }))}
        />
      </header>
      <SongList manifest={manifest} />
    </main>
  )
}
