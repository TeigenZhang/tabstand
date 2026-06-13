import { NextRequest, NextResponse } from 'next/server'
import { findPreviewImage, getDispatcher } from '../../../../../scripts/lib/grab-core.mjs'
import { isAllowedThumbHost } from '../../../../../scripts/lib/search-sources.mjs'
import { assertPublicHttpUrl } from '@/lib/importServer'
import { writeThumbCache, thumbKey } from '@/lib/thumbCache'

// Network I/O — force the Node runtime, no caching
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FETCH_TIMEOUT_MS = 9000

// GET /api/import/preview?url=<tab page url>
//
// On-demand preview for sources whose result list has no thumbnail
// (吉他社 / 易唱网). Fetches the page ONCE, finds its first sheet image,
// and returns a proxied (cached) /api/import/thumb URL the client can
// <img src>. This is the user-triggered path — one fetch per click,
// never a search-time burst — so it stays well under any rate that
// would get the server IP throttled. The page host must be allowlisted.
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url || !isAllowedThumbHost(url)) {
    return NextResponse.json({ error: '不支持预览该来源' }, { status: 400 })
  }
  try {
    await assertPublicHttpUrl(url)
    const dispatcher = await getDispatcher()
    const { image, referer, data, contentType } = await findPreviewImage(url, {
      dispatcher,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // The chosen preview image must itself be allowlisted — both so the
      // probe can't be redirected off-allowlist, and so the proxied URL we
      // hand back doesn't later 400 at /api/import/thumb's allowlist check.
      allowHost: isAllowedThumbHost,
    })
    // The probe already downloaded+validated the bytes — warm the thumb
    // cache so the <img> the client renders next serves from disk, not a
    // second fetch of the same image.
    writeThumbCache(thumbKey(image), { data, contentType })
    const proxied = `/api/import/thumb?u=${encodeURIComponent(image)}&ref=${encodeURIComponent(referer)}`
    return NextResponse.json({ image: proxied })
  } catch (error) {
    const message = error instanceof Error ? error.message : '预览失败'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
