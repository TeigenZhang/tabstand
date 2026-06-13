// ============================================================
// search-sources.mjs — aggregate song search across tab sites
//
// Each source is fetched server-side (plain GET, SSR HTML) and
// parsed into { site, sourceId, free, title, pageUrl, thumbnail }.
// Every row is then run through parseTabTitle to attach song/artist
// candidates (for the import form's auto-prefill). Clicking a result
// feeds pageUrl into the scrape→preview→commit flow.
//
// `free` sources (jitashe, echangwang) give complete multi-page
// sheets. Paywalled sources (jitabang, dapula) only leak previews
// but jitabang has the best search, so we keep it for recall and
// let the grab step block its previews (detectPaywall in grab-core).
//
// searchAll returns { results, sources } — `sources` carries per-site
// status (ok / count / error) so the UI can say "吉他帮：超时" instead
// of a blanket "没搜到".
// ============================================================
import iconv from 'iconv-lite'
import { fetchPage } from './grab-core.mjs'
import { parseTabTitle } from './parse-title.mjs'

// GBK percent-encoding for echangwang (its search rejects UTF-8)
const gbkQuery = (q) =>
  [...iconv.encode(q, 'gbk')]
    .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
    .join('')

const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

const PER_SITE_LIMIT = 8

// Per-variant fetch budget. A source that doesn't answer in time is
// aborted and reported as "超时" instead of stalling the whole search
// (Promise.all waits for the slowest source).
const SEARCH_TIMEOUT_MS = 5000

// Absolutize a (possibly relative) URL against a site base
const abs = (base, u) => {
  try {
    return new URL(u, base).href
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// Per-site parsers — each returns [{ title, pageUrl, thumbnail }]
// ------------------------------------------------------------

export function parseDapula(html) {
  const base = 'https://www.dapula.com'
  const re =
    /<a[^>]*href="(\/show\/\d+\.html)"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/g
  const out = []
  for (const m of html.matchAll(re)) {
    out.push({ pageUrl: abs(base, m[1]), thumbnail: abs(base, m[2]), title: m[3] })
  }
  return out
}

export function parseJitashe(html) {
  const base = 'https://www.jitashe.org'
  const re = /<a[^>]*href="(\/tab\/\d+\/?)"[^>]*>([^<]+)<\/a>/g
  const out = []
  for (const m of html.matchAll(re)) {
    const title = m[2].trim()
    if (title) out.push({ pageUrl: abs(base, m[1]), thumbnail: null, title })
  }
  return out
}

// jitabang — WordPress, the one source that handles "歌手 歌名"
// combined queries (AND matching). Thumbnail is lazy-loaded, so
// the real URL is in data-original, not src (a placeholder).
export function parseJitabang(html) {
  const re =
    /<a class="item-img-inner" href="(https:\/\/www\.jitabang\.com\/jitapu\/\d+\.html)" title="([^"]+)"[^>]*>\s*<img[^>]*>/g
  const out = []
  for (const m of html.matchAll(re)) {
    const thumb = /data-original="([^"]+)"/.exec(m[0])?.[1] ?? null
    out.push({ pageUrl: m[1], thumbnail: thumb, title: m[2] })
  }
  return out
}

// echangwang (易唱网) — free complete sheets, GBK. Result links are
// absolute; the matched term is wrapped in <font> inside the title.
export function parseEchangwang(html) {
  const re =
    /<a href="(http:\/\/www\.echangwang\.com\/(?:pic|tab|gtp|ukulele)\/\d+\/\d+\.html)"[^>]*>(.*?)<\/a>/g
  const out = []
  for (const m of html.matchAll(re)) {
    const title = stripTags(m[2])
    if (title) out.push({ pageUrl: m[1], thumbnail: null, title })
  }
  return out
}

// 绵羊乐谱 (shaomingyang) — DedeCMS, free image sheets, UTF-8 GET
// search. Each result's "focus" anchor carries the list thumbnail
// (uploads/allimg cover ≈ the sheet's first page) and an alt that wraps
// the matched term in <font>. The search interleaves piano rows
// (/gangqinpu/); the /btb/-anchored regex keeps only the guitar tabs.
export function parseShaomingyang(html) {
  const re =
    /<a href="(https?:\/\/www\.shaomingyang\.com\/btb\/\d+\.html)" class="focus"[^>]*>\s*<img[^>]*\balt="([^"]*)"[^>]*\bsrc="([^"]+)"/g
  const out = []
  for (const m of html.matchAll(re)) {
    const title = stripTags(m[2])
    if (title) out.push({ pageUrl: m[1], thumbnail: m[3], title })
  }
  return out
}

// 吉他园地 (jitahome) — free, HTTPS, UTF-8 GET search (?key=). The list
// thumbnail (Aliyun OSS, served with a resize query) lives in a
// "list-item-img" anchor; the title sits in a separate "list-item-title"
// anchor sharing the same /<id>.html href. The two are joined by href
// (a single spanning regex would be brittle across the markup between).
export function parseJitahome(html) {
  const thumbs = new Map()
  const thumbRe =
    /<a class="list-item-img" href="(https:\/\/www\.jitahome\.com\/\d+\.html)"[^>]*>\s*<img[^>]*\bsrc="([^"]+)"/g
  for (const m of html.matchAll(thumbRe)) thumbs.set(m[1], m[2])
  const titleRe =
    /<h2 class="list-item-title">\s*<a href="(https:\/\/www\.jitahome\.com\/\d+\.html)"[^>]*>([^<]+)<\/a>/g
  const out = []
  for (const m of html.matchAll(titleRe)) {
    const title = m[2].trim()
    if (title) out.push({ pageUrl: m[1], thumbnail: thumbs.get(m[1]) ?? null, title })
  }
  return out
}

// ------------------------------------------------------------
// Sources. `id` is the stable handle used by the source filter and
// the result schema (never the Chinese display name). `searchable`
// sources are fetched + parsed; non-searchable ones (17jita, whose
// search.php is nginx-404'd to scrapers) are surfaced in the UI as an
// "external search" entry only — they're never fetched here.
// `free`: complete multi-page sheets vs. paywalled preview.
// ------------------------------------------------------------
const SOURCES = [
  {
    id: 'jitashe',
    site: '吉他社',
    free: true,
    searchable: true,
    searchUrl: (q) => `https://www.jitashe.org/search/tab/${encodeURIComponent(q)}/`,
    parse: parseJitashe,
  },
  {
    id: 'echangwang',
    site: '易唱网',
    free: true,
    searchable: true,
    searchUrl: (q) => `http://www.echangwang.com/plus/search.php?q=${gbkQuery(q)}`,
    parse: parseEchangwang,
  },
  {
    id: 'shaomingyang',
    site: '绵羊乐谱',
    free: true,
    searchable: true,
    searchUrl: (q) =>
      `http://www.shaomingyang.com/plus/search.php?q=${encodeURIComponent(q)}&kwtype=0`,
    parse: parseShaomingyang,
  },
  {
    // 吉他园地 — its GET /search?key= silently ignores the keyword and
    // returns the latest-articles list (precision killer); only the POST
    // form actually filters. So this source posts its query.
    id: 'jitahome',
    site: '吉他园地',
    free: true,
    searchable: true,
    method: 'POST',
    searchUrl: () => 'https://www.jitahome.com/search',
    body: (q) => `key=${encodeURIComponent(q)}`,
    parse: parseJitahome,
  },
  {
    id: 'jitabang',
    site: '吉他帮',
    free: false,
    searchable: true,
    searchUrl: (q) => `https://www.jitabang.com/?s=${encodeURIComponent(q)}`,
    parse: parseJitabang,
  },
  {
    id: 'dapula',
    site: '打谱网',
    free: false,
    searchable: true,
    searchUrl: (q) =>
      `https://www.dapula.com/index.php?s=puku&c=search&keyword=${encodeURIComponent(q)}`,
    parse: parseDapula,
  },
  {
    // 17吉他网 — search.php is hard-blocked at the nginx layer (404 to
    // GET/POST alike), so it can't be SSR-searched. Single-page grab
    // DOES work (cookie challenge + GBK live in grab-core), so we list
    // it for the UI's "去站外搜索 17吉他网" jump → paste-URL flow.
    id: 'seventeen',
    site: '17吉他网',
    free: true,
    searchable: false,
    external: 'https://www.17jita.com',
  },
]

// Public, UI-facing source catalogue (no functions). Drives the source
// filter chips and the 17jita external-search entry.
export const SOURCE_LIST = SOURCES.map(({ id, site, free, searchable, external }) => ({
  id,
  site,
  free,
  searchable,
  external: external ?? null,
}))

// Hosts the thumbnail/preview proxy (/api/import/thumb) is allowed to
// fetch from. Suffix-matched against the registrable domain so CDN
// subdomains (cdn.jitahome.com, static.jitashe.org, i0.hdslb.com) pass
// while look-alikes (jitabang.com.evil.com) do NOT. This is the proxy's
// open-relay / SSRF-amplification guard, layered on top of the
// per-hop assertPublicHttpUrl IP check in grab-core.
export const THUMB_HOST_SUFFIXES = [
  'jitabang.com',
  'dapula.com',
  'shaomingyang.com',
  'jitahome.com',
  'jitashe.org',
  'echangwang.com',
  '17jita.com',
  'hdslb.com', // bilibili article images (preview path)
]

export function isAllowedThumbHost(rawUrl) {
  let host
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return THUMB_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))
}

// Resolve a requested id list to the searchable source ids that will
// actually run: no/empty request → all searchable; unknown ids and
// non-searchable ids (17jita) are dropped. Pure, so it's unit-tested.
export function resolveSearchableSources(ids) {
  const requested = Array.isArray(ids) && ids.length > 0 ? ids : null
  return SOURCES.filter(
    (s) => s.searchable && (!requested || requested.includes(s.id))
  ).map((s) => s.id)
}

// Dedup by pageUrl, cap per site
function dedupe(results) {
  const seen = new Set()
  const out = []
  for (const r of results) {
    if (!r.pageUrl || seen.has(r.pageUrl)) continue
    seen.add(r.pageUrl)
    out.push(r)
    if (out.length >= PER_SITE_LIMIT) break
  }
  return out
}

// Common artists, longest first so "五月天" matches before a shorter
// prefix. Used to split a no-space "歌手+歌名" query ("五月天任性")
// since CJK can't be word-segmented without a dictionary, and shared
// with parseTabTitle as the known-artist vocabulary for prefill.
export const ARTISTS = [
  '万能青年旅店', '房东的猫', '逃跑计划', '隔壁老樊', '好妹妹乐队', '南拳妈妈',
  '五月天', '周杰伦', '陈奕迅', '林俊杰', '李荣浩', '薛之谦', '毛不易', '邓紫棋',
  '张学友', '王力宏', '李宗盛', '罗大佑', '陈绮贞', '宋冬野', '陈鸿宇', '刘昊霖',
  '好妹妹', '谢春花', '尧十三', '张国荣', '张惠妹', '孙燕姿', '梁静茹', '田馥甄',
  '华晨宇', '汪苏泷', '许嵩', '汪峰', '赵雷', '朴树', '陈粒', '花粥', '柳爽', '任然',
  '程响', '周深', '毛宁', 'beyond', '黄家驹', '苏打绿', '痛仰', '五条人',
]

// Capped at MAX_VARIANTS so a long, many-word query can't fan out
// into an unbounded burst of outbound requests (which would get the
// server rate-limited by the source sites).
// Split a no-space "歌手歌名" query by known-artist prefix
function splitArtist(q) {
  if (/\s/.test(q)) return null
  const artist = ARTISTS.find(
    (a) => q.toLowerCase().startsWith(a.toLowerCase()) && q.length > a.length
  )
  return artist ? { artist, song: q.slice(artist.length).trim() } : null
}

// The meaningful terms of a query, for relevance scoring
function keywords(q) {
  const split = splitArtist(q)
  if (split) return [split.artist, split.song].filter((t) => t.length >= 2)
  return q.split(/\s+/).filter((t) => t.length >= 2)
}

const MAX_VARIANTS = 4
function queryVariants(raw) {
  const q = raw.trim()
  const variants = [q]
  const add = (v) => {
    if (v && v.length >= 2 && !variants.includes(v)) variants.push(v)
  }

  // No-space "歌手歌名" → feed the spaced form (for AND-matching
  // sources like jitabang) and the bare song name (for the rest).
  const split = splitArtist(q)
  if (split) {
    add(`${split.artist} ${split.song}`)
    add(split.song)
  }

  // Whitespace tokens on their own (the song name alone usually hits)
  for (const token of q.split(/\s+/)) add(token)

  return variants.slice(0, MAX_VARIANTS)
}

// ------------------------------------------------------------
// Per-source search: run every query variant, parse + dedupe within
// the source, attach song/artist candidates. Returns both a status
// record and the rows. A source that fails (down, markup change,
// timeout) yields { ok:false, error } + [] instead of throwing, so one
// bad source never sinks the whole search.
// ------------------------------------------------------------
async function searchSite(source, variants, query, dispatcher, knownArtists) {
  const status = { id: source.id, site: source.site, free: source.free, ok: false, count: 0 }
  // Variants are independent — a single variant 404/timeout shouldn't
  // drop the whole source, so settle them individually.
  // POST sources (吉他园地…) send the query in a urlencoded form body;
  // GET sources put it in the URL. searchUrl(v) is the endpoint either way.
  const post = source.method === 'POST'
  const settled = await Promise.allSettled(
    variants.map((v) =>
      fetchPage(source.searchUrl(v), dispatcher, {
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        ...(post
          ? {
              method: 'POST',
              body: source.body(v),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            }
          : {}),
      }).then((r) => r.html)
    )
  )
  const pages = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
  if (pages.length === 0) {
    const reason = settled.find((s) => s.status === 'rejected')?.reason
    const timedOut = reason?.name === 'TimeoutError' || reason?.name === 'AbortError'
    status.error = timedOut ? '超时' : reason instanceof Error ? reason.message : '请求失败'
    return { status, rows: [] }
  }

  const rows = dedupe(pages.flatMap((html) => source.parse(html))).map((r) => {
    const { song, artist, confidence } = parseTabTitle(r.title, { query, knownArtists })
    return {
      ...r,
      site: source.site,
      sourceId: source.id,
      free: source.free,
      song,
      artist,
      confidence,
    }
  })
  status.ok = true
  status.count = rows.length
  return { status, rows }
}

// ------------------------------------------------------------
// Public: search the selected sources × query-variants and merge.
// One source failing drops to [] (tracked in `sources`) instead of
// failing the whole search.
//
// opts.sources  — stable ids to include (default: all searchable)
// opts.libraryArtists — artists already in the local library, folded
//                       into the prefill vocabulary
// ------------------------------------------------------------
export async function searchAll(query, dispatcher, opts = {}) {
  const { sources, libraryArtists = [] } = opts
  const selectedIds = resolveSearchableSources(sources)
  const selected = SOURCES.filter((s) => selectedIds.includes(s.id))

  const variants = queryVariants(query)
  // Artist vocabulary = known-artist table ∪ local library artists.
  // The query is passed to parseTabTitle separately (it derives the
  // query's artist via ARTISTS); we deliberately DON'T fold raw query
  // tokens in here, or the song name would pollute artist detection
  // ("晴天" as a query token would get mis-read as an artist).
  const knownArtists = Array.from(new Set([...ARTISTS, ...libraryArtists]))

  const settled = await Promise.all(
    selected.map((source) => searchSite(source, variants, query, dispatcher, knownArtists))
  )

  const sourceStatus = settled.map((s) => s.status)
  const all = settled.flatMap((s) => s.rows)

  // Dedupe across all sources/variants by page URL
  const seen = new Set()
  const merged = []
  for (const r of all) {
    if (!r.pageUrl || seen.has(r.pageUrl)) continue
    seen.add(r.pageUrl)
    merged.push(r)
  }

  // Ranking: relevance first (the right song matters most — a free
  // wrong-artist match shouldn't bury the correct paywalled one, which
  // is tagged so the user can choose), then free (prefer complete).
  //
  // Score works for single-word queries too (the old `terms.length > 1`
  // guard left "晴天" unscored, so free-but-wrong results floated up):
  //   +2  title contains a query term
  //   +3  the parsed song name EQUALS a query term (exact song hit)
  //   +1  title contains the whole query (collapsed)
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '')
  const nq = norm(query.trim())
  const terms = keywords(query.trim())
  const score = (r) => {
    let s = 0
    for (const t of terms) {
      if (r.title.includes(t)) s += 2
      if (r.song && norm(r.song) === norm(t)) s += 3
    }
    if (nq && norm(r.title).includes(nq)) s += 1
    return s
  }
  merged.forEach((r, i) => (r._i = i)) // stable tiebreak
  merged.sort(
    (a, b) => score(b) - score(a) || Number(b.free) - Number(a.free) || a._i - b._i
  )
  merged.forEach((r) => delete r._i)

  return { results: merged, sources: sourceStatus }
}
