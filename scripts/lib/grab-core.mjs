// ============================================================
// grab-core.mjs — shared tab-scraping core
//
// Used by both the CLI (scripts/grab.mjs) and the web import API
// (src/app/api/import/*). Fetches a page, finds the sheet images,
// downloads and filters them, and returns the buffers WITHOUT
// touching the library — callers decide where they land.
//
// Site quirks handled: 17jita cookie challenge + GBK, bilibili
// /read→/opus inline-JSON images, http→https redirects, lazy-load
// attributes, Referer-based hotlink protection.
// ============================================================
import path from 'node:path'
import net from 'node:net'
import dns from 'node:dns/promises'

export const CATEGORIES = new Set(['strumming', 'fingerstyle'])
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|jfif|webp)$/i

const MIN_IMAGE_KB = 10 // hard floor; the real filter is image height
const MIN_SHEET_HEIGHT = 500 // tab scans are tall; logos and banners are not
const POLITE_DELAY_MS = 600
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

const NOISE =
  /logo|avatar|qrcode|thumbnail|titlepic|singer|\/block\/|\/static\/|head_portrait|\bbg\b/i

// Paywall markers — many WP tab sites (jitabang, dapula…) hide the
// real sheet behind the ErphpDown plugin / a VIP wall and only leak
// thumbnails. Detect it so we fail with a clear message instead of
// staging a junk preview thumbnail.
// High-precision only: the ErphpDown plugin marker + its exact price
// text. Broad class/keyword matching (vip/pay/blur/购买/积分) caused
// false positives on free sites (echangwang has class="blur"), so we
// require unambiguous paywall signatures.
const PAYWALL = /erphpdown|erphp-login-must|此内容查看价格为|登录后(?:可见|可查看|可下载)|开通(?:VIP|超级会员|会员)后可|VIP专享下载|会员专享下载/i

function detectPaywall(html) {
  return PAYWALL.test(html)
}

// Drop scaled/derivative copies. echangwang serves several
// re-encoded copies per page ("X.png" plus "X-50.png", "X-51.png");
// when the un-suffixed base is also present, the suffixed one is a
// copy.
//
// SCOPED TO echangwang ONLY: on other sites "-2"/"-3" can be real
// page numbers, so collapsing "X-2.png" because "X.png" exists would
// silently drop pages. echangwang's real pages have distinct bases
// (…342, …343), never X + X-2, so the rule is safe there.
// Real host check — not a substring match, so "evil.com/?x=
// echangwang.com" or "echangwang.com.evil.com" can't trip the rule
// and drop a real page on some other site.
function isEchangwangHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === 'echangwang.com' || h.endsWith('.echangwang.com')
  } catch {
    return false
  }
}

function dropScaledCopies(candidates, log) {
  const urls = new Set(candidates.map((c) => c.url))
  let dropped = 0
  const kept = candidates.filter((c) => {
    if (!isEchangwangHost(c.url)) return true
    const m = c.url.match(/^(.*?)-\d+(\.[a-z]+)(?:[?#].*)?$/i)
    if (m && urls.has(m[1] + m[2])) {
      dropped++
      return false
    }
    return true
  })
  if (dropped > 0) log(`已去重 ${dropped} 张缩放副本`)
  return kept
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------
// SSRF guard — applied to BOTH the page URL and every image URL
// pulled from page content, so a public page can't redirect the
// server into the internal network via crafted <img src>.
// Blocks loopback / private / link-local / cloud-metadata /
// Tailscale CGNAT (100.64/10) and non-http(s) schemes.
// ------------------------------------------------------------
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT — Tailscale
    if (a >= 240) return true // 240/4 reserved
    // NOTE: 198.18/15 (RFC 2544) is deliberately NOT blocked — Clash
    // fake-ip maps all proxied public domains into that range, so
    // blocking it would break every foreign tab site behind the proxy.
    return false
  }
  const ipv6 = ip.toLowerCase()
  if (ipv6 === '::1' || ipv6 === '::') return true
  if (ipv6.startsWith('fe80')) return true
  if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true
  if (ipv6.startsWith('::ffff:')) return isPrivateIp(ipv6.slice(7))
  return false
}

/**
 * @param {string} raw
 * @returns {Promise<URL>} throws if the target is internal/reserved
 */
export async function assertPublicHttpUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('非法网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http/https 网址')
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('禁止抓取内网地址')
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error('禁止抓取内网/保留地址')
  }
  let records
  try {
    records = await dns.lookup(host, { all: true })
  } catch {
    throw new Error('无法解析域名')
  }
  if (records.some((r) => isPrivateIp(r.address))) {
    throw new Error('禁止抓取内网/保留地址')
  }
  return url
}

const isPublicHttpUrl = async (raw) => {
  try {
    await assertPublicHttpUrl(raw)
    return true
  } catch {
    return false
  }
}

// Fetch that follows redirects MANUALLY, re-running the SSRF guard
// on every hop. `redirect: 'follow'` would let a public host 30x
// the server into the internal network after the pre-check; here
// each target is validated before it is ever fetched. Legit hops
// (http→https, B站 /read→/opus) are public, so they pass.
const MAX_REDIRECTS = 5
// `allowHost(url)` (optional): an extra per-hop host allowlist, checked on
// the initial URL AND every redirect target. The thumbnail proxy passes it
// so an allowlisted host's open-redirect/CDN 30x can't make the proxy fetch
// off-allowlist content (the IP-SSRF guard alone wouldn't catch that).
async function safeFetch(url, { headers = {}, dispatcher, signal, method = 'GET', body, allowHost } = {}) {
  let current = url
  let curMethod = method
  let curBody = body
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(current) // pre-flight guard on every hop
    if (allowHost && !allowHost(current)) {
      throw new Error('目标地址不在允许的域名内')
    }
    const res = await fetch(current, {
      method: curMethod,
      headers,
      body: curBody,
      dispatcher,
      redirect: 'manual',
      signal,
    })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      await res.arrayBuffer().catch(() => {}) // drain to free the socket
      try {
        current = new URL(location, current).href
      } catch {
        throw new Error('非法重定向地址')
      }
      // Per the fetch spec, a 301/302/303 turns a POST into a GET and
      // drops the body; only 307/308 preserve method+body. The WordPress
      // /EmpireCMS search POSTs that need this 302 to a GET result page,
      // so collapsing to GET here is exactly the desired behaviour.
      if (res.status !== 307 && res.status !== 308) {
        curMethod = 'GET'
        curBody = undefined
      }
      continue
    }
    return res
  }
  throw new Error('重定向次数过多')
}

export async function getDispatcher(proxy = process.env.GRAB_PROXY) {
  if (!proxy) return undefined
  const { ProxyAgent } = await import('undici')
  return new ProxyAgent(proxy)
}

// NOTE on TOCTOU / DNS-rebinding: ideally we'd pin the connection to
// the exact IP we validated (custom undici connector lookup). But
// this dev/deploy machine runs a Clash-style proxy with fake-ip DNS
// — domains resolve to synthetic 198.18/15 addresses and the proxy
// does the real routing by hostname. Pinning to the resolved "IP"
// breaks that routing (the site returns a stripped anti-bot page).
// So we keep the per-hop pre-flight guard (assertPublicHttpUrl on
// the page URL, every image URL, and every redirect hop) and accept
// the small rebinding window. For a Tailscale-only LAN tool that's
// proportionate; if ever exposed publicly, add auth + IP pinning in
// a non-fake-ip network.

// ------------------------------------------------------------
// Image URL extraction
// ------------------------------------------------------------
function extractImageCandidates(html, pageUrl) {
  const seen = new Set()
  const candidates = []
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? []

  for (const tag of imgTags) {
    const attr = (name) =>
      tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]
    const raw =
      attr('data-src') ?? attr('data-original') ?? attr('data-url') ?? attr('src')
    if (!raw || raw.startsWith('data:')) continue
    try {
      const url = new URL(raw, pageUrl).href
      if (seen.has(url)) continue
      seen.add(url)
      candidates.push({ url, alt: `${attr('alt') ?? ''} ${attr('title') ?? ''}` })
    } catch {
      // Unparseable URL — skip
    }
  }
  return candidates
}

// Minimal PNG/JPEG/GIF header probing — avoids an image library
// just to reject logos and banners
/**
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function getImageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]
      const size = buf.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        }
      }
      offset += 2 + size
    }
  }
  return null // unknown format — caller decides
}

// Identify a RASTER image by magic bytes and return its canonical MIME.
// Used by the thumbnail proxy to serve a type derived from the bytes
// themselves (never the server's Content-Type) — so an allowlisted CDN
// can't smuggle image/svg+xml (active content → same-origin XSS) past it.
export function rasterMime(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

const cleanBilibiliUrl = (url) =>
  url.includes('hdslb.com') ? url.split('@')[0] : url

function isBilibiliArticle(url) {
  return /bilibili\.com\/(read\/(cv|mobile)|opus\/)/i.test(url)
}

function extractBilibiliImages(html) {
  const matches =
    html.match(
      /(?:https?:)?\/\/i\d\.hdslb\.com\/bfs\/(?:article|new_dyn|opus)\/[^"'\\\s)@]+\.(?:jpe?g|png|gif|webp)/gi
    ) ?? []
  return [...new Set(matches.map((u) => (u.startsWith('//') ? `https:${u}` : u)))]
    .filter((u) => !u.includes('/watermark/'))
    .map((url) => ({ url, alt: '' }))
}

// ------------------------------------------------------------
// Page fetch — charset decoding + 17jita cookie challenge
// ------------------------------------------------------------
function decodeBody(buf, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]
  if (!charset) {
    const head = buf.subarray(0, 1024).toString('latin1')
    charset = /charset=["']?([\w-]+)/i.exec(head)?.[1]
  }
  charset = (charset ?? 'utf-8').toLowerCase()
  try {
    return new TextDecoder(charset).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

function solveCookieChallenge(html, setCookie) {
  if (!/getCookie|secret|token/.test(html) || html.length > 4000) return null
  const token = /token=([^;,\s]+)/.exec(setCookie ?? '')?.[1]
  const secret = /secret=(\d+)/.exec(setCookie ?? '')?.[1]
  if (!token || !secret) return null
  return `t=${token}; r=${Number(secret) - 100}`
}

// `signal` (optional) bounds the whole fetch — including the cookie
// challenge's second round-trip — so a slow source can be aborted by
// the search layer instead of hanging the whole aggregation.
//
// `method`/`body`/`headers` (optional) support POST search endpoints
// (e.g. 吉他园地, EmpireCMS sites) whose GET form silently ignores the
// keyword. The cookie-challenge retry always re-issues as a plain GET
// (POST search hosts don't run the 17jita JS challenge).
export async function fetchPage(url, dispatcher, { signal, method = 'GET', body, headers = {} } = {}) {
  const res = await safeFetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    dispatcher,
    signal,
    method,
    body,
  })
  if (!res.ok) throw new Error(`页面请求失败：HTTP ${res.status}`)

  const buf = Buffer.from(await res.arrayBuffer())
  let html = decodeBody(buf, res.headers.get('content-type'))
  let finalUrl = res.url

  const challengeCookie = solveCookieChallenge(html, res.headers.get('set-cookie'))
  if (challengeCookie) {
    await sleep(POLITE_DELAY_MS)
    const res2 = await safeFetch(res.url, {
      headers: { 'User-Agent': UA, Cookie: challengeCookie, Referer: url },
      dispatcher,
      signal,
    })
    const buf2 = Buffer.from(await res2.arrayBuffer())
    html = decodeBody(buf2, res2.headers.get('content-type'))
    finalUrl = res2.url
  }
  return { html, finalUrl }
}

async function downloadImage(url, referer, dispatcher, attempt = 1) {
  try {
    const res = await safeFetch(url, {
      headers: { 'User-Agent': UA, Referer: referer },
      dispatcher,
    })
    if (!res.ok) return null

    const type = (res.headers.get('content-type') ?? '').split(';')[0]
    const ext =
      EXT_BY_TYPE[type] ??
      (path.extname(new URL(url).pathname).toLowerCase() || null)
    if (!ext || !IMAGE_EXT_RE.test(ext)) return null

    const data = Buffer.from(await res.arrayBuffer())
    return { data, ext }
  } catch (error) {
    if (attempt < 3) {
      await sleep(POLITE_DELAY_MS * attempt)
      return downloadImage(url, referer, dispatcher, attempt + 1)
    }
    throw error
  }
}

// ------------------------------------------------------------
// Public: collect sheet images from a page (no disk writes)
//
// Returns { images: [{ data, ext, width, height }], finalUrl }.
// `onProgress(msg)` is optional (CLI prints, API stays silent).
// ------------------------------------------------------------
/**
 * @param {string} url
 * @param {{ name?: string, dispatcher?: any, onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<{ images: { data: Buffer, ext: string, width?: number, height?: number }[], finalUrl: string, title: string }>}
 */
export async function collectSheetImages(url, { name = '', dispatcher, onProgress } = {}) {
  const log = onProgress ?? (() => {})
  await assertPublicHttpUrl(url) // SSRF: guard the page URL (CLI path too)
  const { html, finalUrl } = await fetchPage(url, dispatcher)
  // Page <title> feeds artist/song prefill on the paste-URL path
  const pageTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? ''

  // Bail early on paywalled pages — the real sheet isn't in the
  // public HTML, only thumbnails, so grabbing yields junk.
  if (!isBilibiliArticle(url) && detectPaywall(html)) {
    throw new Error('这首是付费谱（仅预览），抓不到完整谱。换免费来源试试（如吉他社）')
  }

  let candidates
  let semantic = false
  if (isBilibiliArticle(url)) {
    candidates = extractBilibiliImages(html).map((c) => ({
      ...c,
      url: cleanBilibiliUrl(c.url),
    }))
  } else {
    candidates = dropScaledCopies(
      extractImageCandidates(html, finalUrl)
        .map((c) => ({ ...c, url: cleanBilibiliUrl(c.url) }))
        .filter((c) => !NOISE.test(c.url)),
      log
    )
    const hits = candidates.filter(
      (c) => (name && c.alt.includes(name)) || c.alt.includes('吉他谱')
    )
    if (hits.length > 0) {
      candidates = hits
      semantic = true
    }
  }

  if (candidates.length === 0) {
    throw new Error('页面里没找到图片，可能需要登录或为 JS 动态渲染')
  }

  // SSRF: image srcs come from (attacker-controllable) page content,
  // so drop any that resolve to internal/reserved addresses before
  // we fetch them. Done concurrently — these are read-only checks.
  const verdicts = await Promise.all(candidates.map((c) => isPublicHttpUrl(c.url)))
  const blocked = candidates.length - verdicts.filter(Boolean).length
  candidates = candidates.filter((_, i) => verdicts[i])
  if (blocked > 0) log(`已拦截 ${blocked} 个内网/非法图片地址`)
  if (candidates.length === 0) {
    throw new Error('候选图片均指向内网/保留地址，已全部拦截')
  }
  log(`候选图片 ${candidates.length} 张${semantic ? '（alt 语义命中）' : ''}…`)

  const referer = isBilibiliArticle(url) ? 'https://www.bilibili.com' : finalUrl
  const images = []
  for (const { url: imgUrl } of candidates) {
    try {
      const result = await downloadImage(imgUrl, referer, dispatcher)
      if (!result || result.data.length < MIN_IMAGE_KB * 1024) continue
      const size = getImageSize(result.data)
      if (size && size.height < MIN_SHEET_HEIGHT) continue
      images.push({ data: result.data, ext: result.ext, ...(size ?? {}) })
      log(`  ✓ ${images.length}${result.ext}${size ? ` ${size.width}×${size.height}` : ''}`)
    } catch (error) {
      log(`  ✗ ${imgUrl}：${error.message}`)
    }
    await sleep(POLITE_DELAY_MS)
  }

  if (images.length === 0) {
    throw new Error('没有符合谱图条件的图片（高度均 <500px 或下载失败）')
  }
  return { images, finalUrl, title: pageTitle }
}

// Generous cap for a proxied cover/preview image — these are small, so
// it still rejects a hostile multi-MB body from an allowlisted host.
const MAX_PROXY_IMAGE_BYTES = 6 * 1024 * 1024

// ------------------------------------------------------------
// Thumbnail-proxy support (web import only)
// ------------------------------------------------------------

// Fetch a single image's bytes through the SSRF-guarded fetch, with a
// site Referer (some CDNs hotlink-protect) and a size cap. Powers the
// /api/import/thumb proxy — NOT the library grab path. `allowHost` (passed
// by the proxy) confines every hop to the thumbnail allowlist.
/**
 * @param {string} url
 * @param {{ referer?: string, dispatcher?: any, signal?: AbortSignal, allowHost?: (u: string) => boolean }} [opts]
 * @returns {Promise<{ data: Buffer, contentType: string }>}
 */
export async function fetchImageBytes(url, { referer, dispatcher, signal, allowHost } = {}) {
  const res = await safeFetch(url, {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    dispatcher,
    signal,
    allowHost,
  })
  if (!res.ok) throw new Error(`图片请求失败：HTTP ${res.status}`)
  const headerType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!headerType.startsWith('image/')) throw new Error('目标不是图片')

  // Reject early if the server declares an over-cap size…
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PROXY_IMAGE_BYTES) {
    throw new Error('图片过大')
  }
  // …and enforce the cap WHILE streaming, so a missing/lying Content-Length
  // (or chunked body) still can't buffer an unbounded image into memory.
  let data
  const reader = res.body?.getReader?.()
  if (!reader) {
    data = Buffer.from(await res.arrayBuffer())
    if (data.length > MAX_PROXY_IMAGE_BYTES) throw new Error('图片过大')
  } else {
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PROXY_IMAGE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('图片过大')
      }
      chunks.push(Buffer.from(value))
    }
    data = Buffer.concat(chunks)
  }

  // Trust the BYTES, not the header: derive the served type from the magic
  // number and only allow raster formats. Drops image/svg+xml (and anything
  // mislabelled image/*) so the proxy can never serve active content.
  const contentType = rasterMime(data)
  if (!contentType) throw new Error('不支持的图片类型（仅 png/jpg/gif/webp）')
  return { data, contentType }
}

// How many candidates the preview probe will download before giving up.
// Bounds the cost of one 预览 click (most pages hit a real sheet in 1–2).
const PREVIEW_PROBE_LIMIT = 6

// Find ONE real sheet image on a tab page for the on-demand preview —
// for sources whose result list carries no thumbnail (吉他社/易唱网).
// Unlike collectSheetImages it doesn't pull every page: it probes
// candidates in order (alt-semantic hits first, so the actual sheet wins
// over sidebar/related thumbnails) and returns the first that's a real
// sheet (tall enough, not a logo/avatar). The bytes are returned too, so
// the caller can warm the thumb cache without a second download.
// One page fetch + ≤6 image probes per click — never a search-time burst.
/**
 * @param {string} url
 * @param {{ name?: string, dispatcher?: any, signal?: AbortSignal, allowHost?: (u: string) => boolean }} [opts]
 * @returns {Promise<{ image: string, referer: string, data: Buffer, contentType: string }>}
 */
export async function findPreviewImage(url, { name = '', dispatcher, signal, allowHost } = {}) {
  await assertPublicHttpUrl(url)
  const { html, finalUrl } = await fetchPage(url, dispatcher, { signal })
  if (!isBilibiliArticle(url) && detectPaywall(html)) {
    throw new Error('付费谱，无可预览图')
  }
  let candidates = isBilibiliArticle(url)
    ? extractBilibiliImages(html).map((c) => ({ ...c, url: cleanBilibiliUrl(c.url) }))
    : dropScaledCopies(
        extractImageCandidates(html, finalUrl)
          .map((c) => ({ ...c, url: cleanBilibiliUrl(c.url) }))
          .filter((c) => !NOISE.test(c.url)),
        () => {}
      )
  // SSRF: image srcs are attacker-controllable — drop internal targets
  // before the proxy is ever pointed at them.
  const verdicts = await Promise.all(candidates.map((c) => isPublicHttpUrl(c.url)))
  candidates = candidates.filter((_, i) => verdicts[i])
  if (candidates.length === 0) throw new Error('没找到可预览的谱图')

  // Probe semantic-alt hits (song name / "吉他谱") first, then the rest.
  const isSemantic = (c) => (name && c.alt.includes(name)) || c.alt.includes('吉他谱')
  const ordered = [...candidates.filter(isSemantic), ...candidates.filter((c) => !isSemantic(c))]
  const referer = isBilibiliArticle(url) ? 'https://www.bilibili.com' : finalUrl

  for (const c of ordered.slice(0, PREVIEW_PROBE_LIMIT)) {
    try {
      const { data, contentType } = await fetchImageBytes(c.url, { referer, dispatcher, signal, allowHost })
      if (data.length < MIN_IMAGE_KB * 1024) continue // too small → logo/icon
      const size = getImageSize(data)
      if (size && size.height < MIN_SHEET_HEIGHT) continue // banner/cover, not a sheet
      return { image: c.url, referer, data, contentType }
    } catch {
      // unreachable/forbidden candidate — try the next
    }
  }
  throw new Error('没找到可预览的谱图')
}
