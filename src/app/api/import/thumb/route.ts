import { NextRequest, NextResponse } from 'next/server'
import { fetchImageBytes, getDispatcher } from '../../../../../scripts/lib/grab-core.mjs'
import { isAllowedThumbHost } from '../../../../../scripts/lib/search-sources.mjs'
import { readThumbCache, writeThumbCache, thumbKey } from '@/lib/thumbCache'

// Network I/O — force the Node runtime, no caching of the route itself
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FETCH_TIMEOUT_MS = 8000

// GET /api/import/thumb?u=<image url>&ref=<referer>
//
// Proxies a remote tab-site thumbnail / preview image:
//   · server-side fetch with the correct Referer → defeats hotlink
//     protection AND keeps the user's IP off the source CDN (privacy);
//   · allowlisted to known tab-site hosts only → it can't be turned
//     into an open image proxy / SSRF amplifier (layered on the per-hop
//     IP guard in grab-core);
//   · disk-cached fetch-once → a repeated search re-renders from disk,
//     so the proxy's outbound footprint stays ≈ one normal page view.
//
// Both `u` and `ref` must be on the allowlist; a bad/blocked thumbnail
// returns 502 and the UI just hides that one image.
export async function GET(req: NextRequest) {
  const u = req.nextUrl.searchParams.get('u')
  if (!u || !isAllowedThumbHost(u)) {
    return NextResponse.json({ error: '非法图片地址' }, { status: 400 })
  }
  const refParam = req.nextUrl.searchParams.get('ref')
  const referer =
    refParam && isAllowedThumbHost(refParam) ? refParam : `${new URL(u).origin}/`

  const key = thumbKey(u)
  const cached = readThumbCache(key)
  if (cached) return serveImage(cached.data, cached.contentType)

  try {
    const dispatcher = await getDispatcher()
    const { data, contentType } = await fetchImageBytes(u, {
      referer,
      dispatcher,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      allowHost: isAllowedThumbHost, // confine redirects to the allowlist too
    })
    writeThumbCache(key, { data, contentType })
    return serveImage(data, contentType)
  } catch {
    return NextResponse.json({ error: '取图失败' }, { status: 502 })
  }
}

function serveImage(data: Buffer, contentType: string): NextResponse {
  // A Buffer is a valid response body at runtime; the cast just bridges
  // @types/node's generic Buffer<ArrayBufferLike> to DOM BodyInit.
  return new NextResponse(data as unknown as BodyInit, {
    headers: {
      'Content-Type': contentType,
      // Defence in depth: contentType is already a sniffed raster MIME, and
      // nosniff stops the browser re-interpreting the bytes as anything else.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  })
}
