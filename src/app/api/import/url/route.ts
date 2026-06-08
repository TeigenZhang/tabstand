import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { checkSameOrigin } from '@/lib/sameOrigin'
import { collectSheetImages, getDispatcher } from '../../../../../scripts/lib/grab-core.mjs'
import {
  assertPublicHttpUrl,
  listStaging,
  sweepStaging,
  writeStaging,
} from '@/lib/importServer'

// Scraping does network I/O — force the Node runtime, no caching
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST { url, name } → scrape into a staging area, return preview.
// Commit happens later via /api/import/commit.
export async function POST(req: NextRequest) {
  const crossOrigin = checkSameOrigin(req)
  if (crossOrigin) return crossOrigin
  try {
    const { url, name } = await req.json()
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: '缺少 url' }, { status: 400 })
    }

    // SSRF guard: reject internal/reserved targets before fetching.
    // Note: fetch follows redirects, so a public host could still
    // 30x to an internal one — acceptable residual for a LAN tool;
    // the trust boundary is the network (keep off the public net).
    try {
      await assertPublicHttpUrl(url)
    } catch (guardError) {
      const message = guardError instanceof Error ? guardError.message : '非法网址'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    const dispatcher = await getDispatcher()
    const { images } = await collectSheetImages(url, { name: name ?? '', dispatcher })

    sweepStaging() // clear abandoned sessions before creating a new one
    const id = crypto.randomUUID()
    writeStaging(id, images)
    return NextResponse.json({ id, images: listStaging(id) })
  } catch (error) {
    const message = error instanceof Error ? error.message : '抓取失败'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
