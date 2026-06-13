import { NextRequest, NextResponse } from 'next/server'
import { getDispatcher } from '../../../../../scripts/lib/grab-core.mjs'
import { searchAll } from '../../../../../scripts/lib/search-sources.mjs'
import { libraryArtists } from '@/lib/manifest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_QUERY_LEN = 80

// GET /api/import/search?q=<song>&sources=jitashe,echangwang
// Aggregates results across the SSR-parseable source sites. `sources`
// (optional, comma-separated stable ids) restricts which sites run;
// omitted → all searchable sources. Unknown ids are dropped by
// searchAll, so a bad value just narrows the set, never SSRFs.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim().slice(0, MAX_QUERY_LEN)
  if (!q) return NextResponse.json({ results: [], sources: [] })

  const sourcesParam = req.nextUrl.searchParams.get('sources')?.trim()
  const sources = sourcesParam
    ? sourcesParam.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined

  try {
    const dispatcher = await getDispatcher()
    const { results, sources: status } = await searchAll(q, dispatcher, {
      sources,
      libraryArtists: libraryArtists(),
    })
    return NextResponse.json({ results, sources: status })
  } catch (error) {
    const message = error instanceof Error ? error.message : '搜索失败'
    return NextResponse.json({ error: message, results: [], sources: [] }, { status: 502 })
  }
}
