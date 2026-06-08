import { NextRequest, NextResponse } from 'next/server'

// ============================================================
// Same-origin guard for mutating APIs. CORS only blocks READING
// a cross-origin response — a malicious page can still fire a
// blind no-cors POST at this self-hosted app (localhost / LAN /
// Tailscale) and delete or rewrite library content. Browsers
// always attach Origin to POST, so:
//   - Origin present and ≠ Host → reject
//   - Sec-Fetch-Site: cross-site → reject
//   - no Origin (curl, scripts, same-origin GET) → allow
// ============================================================

export function checkSameOrigin(req: NextRequest): NextResponse | null {
  const origin = req.headers.get('origin')
  if (origin) {
    const host = req.headers.get('host')
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return forbidden()
    }
    if (!host || originHost !== host) return forbidden()
  }
  if (req.headers.get('sec-fetch-site') === 'cross-site') return forbidden()
  return null
}

function forbidden(): NextResponse {
  return NextResponse.json({ error: '跨站请求被拒绝' }, { status: 403 })
}
