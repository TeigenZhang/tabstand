// ============================================================
// search-sources.mjs — aggregate song search across tab sites
//
// Each source is fetched server-side (plain GET, SSR HTML) and
// parsed into { site, free, title, pageUrl, thumbnail }. Clicking
// a result feeds pageUrl into the scrape→preview→commit flow.
//
// `free` sources (jitashe, echangwang) give complete multi-page
// sheets. Paywalled sources (jitabang, dapula) only leak previews
// but jitabang has the best search, so we keep it for recall and
// let the grab step block its previews (detectPaywall in grab-core).
// ============================================================
import iconv from 'iconv-lite'
import { fetchPage } from './grab-core.mjs'

// GBK percent-encoding for echangwang (its search rejects UTF-8)
const gbkQuery = (q) =>
  [...iconv.encode(q, 'gbk')]
    .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
    .join('')

const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

const PER_SITE_LIMIT = 8

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

function parseJitapai(html) {
  const base = 'https://www.jitapai.com'
  const re =
    /<a class="thumbnail-link" href="(https:\/\/www\.jitapai\.com\/\d+\.html)"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/g
  const out = []
  for (const m of html.matchAll(re)) {
    out.push({ pageUrl: m[1], thumbnail: abs(base, m[2]), title: m[3] })
  }
  return out
}

function parseDapula(html) {
  const base = 'https://www.dapula.com'
  const re =
    /<a[^>]*href="(\/show\/\d+\.html)"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/g
  const out = []
  for (const m of html.matchAll(re)) {
    out.push({ pageUrl: abs(base, m[1]), thumbnail: abs(base, m[2]), title: m[3] })
  }
  return out
}

function parseJitashe(html) {
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
function parseJitabang(html) {
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
function parseEchangwang(html) {
  const re =
    /<a href="(http:\/\/www\.echangwang\.com\/(?:pic|tab|gtp|ukulele)\/\d+\/\d+\.html)"[^>]*>(.*?)<\/a>/g
  const out = []
  for (const m of html.matchAll(re)) {
    const title = stripTags(m[2])
    if (title) out.push({ pageUrl: m[1], thumbnail: null, title })
  }
  return out
}

// free: complete multi-page sheets. !free: paywalled preview — kept
// only for search recall; the grab step blocks the actual preview.
const SOURCES = [
  {
    site: '吉他社',
    free: true,
    searchUrl: (q) => `https://www.jitashe.org/search/tab/${encodeURIComponent(q)}/`,
    parse: parseJitashe,
  },
  {
    site: '易唱网',
    free: true,
    searchUrl: (q) => `http://www.echangwang.com/plus/search.php?q=${gbkQuery(q)}`,
    parse: parseEchangwang,
  },
  {
    site: '吉他帮',
    free: false,
    searchUrl: (q) => `https://www.jitabang.com/?s=${encodeURIComponent(q)}`,
    parse: parseJitabang,
  },
  {
    site: '打谱网',
    free: false,
    searchUrl: (q) =>
      `https://www.dapula.com/index.php?s=puku&c=search&keyword=${encodeURIComponent(q)}`,
    parse: parseDapula,
  },
]

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
// since CJK can't be word-segmented without a dictionary.
const ARTISTS = [
  '万能青年旅店', '房东的猫', '逃跑计划', '隔壁老樊', '好妹妹乐队', '南拳妈妈',
  '五月天', '周杰伦', '陈奕迅', '林俊杰', '李荣浩', '薛之谦', '毛不易', '邓紫棋',
  '张学友', '王力宏', '李宗盛', '罗大佑', '陈绮贞', '宋冬野', '陈鸿宇', '刘昊霖',
  '好妹妹', '谢春花', '尧十三', '张国荣', '张惠妹', '孙燕姿', '梁静茬', '田馥甄',
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

async function searchSite(source, query, dispatcher) {
  try {
    // Each source encodes the raw query itself (echangwang needs GBK)
    const { html } = await fetchPage(source.searchUrl(query), dispatcher)
    return dedupe(source.parse(html)).map((r) => ({
      ...r,
      site: source.site,
      free: source.free,
    }))
  } catch {
    return []
  }
}

// ------------------------------------------------------------
// Public: search every source × query-variant in parallel and
// merge. One source failing (down, markup change) drops to []
// instead of failing the whole search.
// ------------------------------------------------------------
export async function searchAll(query, dispatcher) {
  const variants = queryVariants(query)
  const jobs = SOURCES.flatMap((source) =>
    variants.map((v) => searchSite(source, v, dispatcher))
  )
  const all = (await Promise.all(jobs)).flat()

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
  // Score = how many query terms (artist + song, even for no-space
  // input) the title contains.
  const terms = keywords(query.trim())
  const relevance = (r) =>
    terms.length > 1 ? terms.reduce((n, t) => n + (r.title.includes(t) ? 1 : 0), 0) : 0
  merged.forEach((r, i) => (r._i = i)) // stable tiebreak
  merged.sort(
    (a, b) =>
      relevance(b) - relevance(a) || Number(b.free) - Number(a.free) || a._i - b._i
  )
  merged.forEach((r) => delete r._i)
  return merged
}
