import { NextRequest, NextResponse } from 'next/server'
import { getDispatcher } from '../../../../../scripts/lib/grab-core.mjs'
import { searchAll } from '../../../../../scripts/lib/search-sources.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/import/search?q=<song> → aggregated results across
// the SSR-parseable source sites
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim()
  if (!q) return NextResponse.json({ results: [] })
  try {
    const dispatcher = await getDispatcher()
    const results = await searchAll(q, dispatcher)
    return NextResponse.json({ results })
  } catch (error) {
    const message = error instanceof Error ? error.message : '搜索失败'
    return NextResponse.json({ error: message, results: [] }, { status: 502 })
  }
}
