// ============================================================
// parse-title.mjs — split a noisy tab-site title into song + artist
//
// Chinese tab sites title results in a handful of recurring shapes:
//   歌名吉他谱_歌手_G调…        (echangwang)
//   歌手《歌名》吉他谱…           (dapula, echangwang)
//   歌名（歌手原版吉他谱…）       (jitashe — artist buried in parens)
//   歌名吉他谱_G调原版_歌手_…     (jitabang — artist mid-string)
//
// parseTabTitle returns { song, artist, confidence }. Confidence is
// 0..1; the caller auto-fills the artist field only at ≥0.75 and
// otherwise shows it as a soft "可能歌手" hint. Pure + dependency-free
// so it's shared by search aggregation and the paste-URL path, and
// unit-tested in isolation.
//
// `knownArtists` is the caller's vocabulary (a common-artist table ∪
// artists already in the local library ∪ the search query's tokens) —
// a title segment that matches it is a high-confidence artist; an
// unknown segment is only a low-confidence guess.
// ============================================================

// Tab-type keywords that mark the boundary between 歌名 and the rest
const TAB_KW = /(双吉他谱|吉他谱|指弹谱|六线谱|弹唱谱|和弦谱|尤克里里谱|尤克里里|简谱|曲谱|乐谱)/

// Segments matching these are arrangement/format noise, never artists
const NOISE =
  /(双?吉他谱|六线谱|弹唱谱|指弹谱|和弦谱|尤克里里谱?|简谱|曲谱|乐谱|高清|完整版|完美版?|原版|简单版|进阶版|中级版|初级版|入门版|新手版|超?清版?|弹唱|独奏|教学|演示|示范|视频|讲解|教程|吉他课堂|吉他教室|乐器)/
const TONE = /[A-G][#♯b♭]?调|变调夹|升[A-G]调|降[A-G]调/

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')

// Trailing site / teaching-studio attribution, e.g. "_图片谱_XX吉他网"
// or "悠音吉他课堂". Stripped before parsing so it can't be mistaken
// for an artist segment.
// NOTE: each pattern matches only the FINAL segment (use [^\s_] runs,
// never \S* — \S spans underscores and would greedily eat the artist
// segment in the middle, e.g. "_周杰伦_简单版_…吉他教学").
const stripSiteSuffix = (t) =>
  t
    .replace(/[_\s]*图片谱[_\s]*[^\s]*$/u, '')
    .replace(/[_\s|]+[^\s_|]*(吉他网|吉他世界网|易唱网|曲谱网|乐器网)\s*$/u, '')
    .replace(/[\s_]+[^\s_]*吉他(课堂|教室|教学|社)[^\s_]*$/u, '')
    .trim()

// Split into candidate segments on the usual separators
const segments = (s) =>
  s
    .split(/[_\s\-—|·、，,／/]+/u)
    .map((x) => x.trim())
    .filter(Boolean)

const isNoiseSeg = (seg) => NOISE.test(seg) || TONE.test(seg) || /谱$/.test(seg)

// A segment that plausibly reads as an artist name (CJK / latin, not
// absurdly long, not pure noise)
const looksLikeName = (seg) =>
  !isNoiseSeg(seg) && /^[一-龥A-Za-z0-9·&]{2,12}$/u.test(seg)

// Strip bracketed asides "（…）(…)【…】[…]" from a song candidate
const stripBrackets = (s) =>
  s.replace(/[（(【\[][^）)】\]]*[）)】\]]/gu, '').trim()

// ------------------------------------------------------------
// Pick the best artist out of ordered candidate segments.
// Returns { artist, tier } where tier ∈ 'known' | 'query' | 'guess'.
// ------------------------------------------------------------
function pickArtist(candidates, artists, queryArtist) {
  // 1) exact known-artist segment
  for (const c of candidates) if (artists.includes(c)) return { artist: c, tier: 'known' }
  // 2) the query's artist appearing inside a segment
  if (queryArtist)
    for (const c of candidates)
      if (c.includes(queryArtist)) return { artist: queryArtist, tier: 'query' }
  // 3) a known artist as substring of a segment (e.g. glued "五月天倔强")
  for (const c of candidates) {
    const hit = artists.find((a) => c.includes(a))
    if (hit) return { artist: hit, tier: 'known' }
  }
  // 4) first name-shaped non-noise segment — only a guess
  for (const c of candidates) if (looksLikeName(c)) return { artist: c, tier: 'guess' }
  return { artist: '', tier: null }
}

const CONF = { known: 0.85, query: 0.9, guess: 0.6 }

/**
 * @param {string} rawTitle
 * @param {{ query?: string, knownArtists?: string[] }} [opts]
 * @returns {{ song: string, artist: string, confidence: number }}
 */
export function parseTabTitle(rawTitle, { query = '', knownArtists = [] } = {}) {
  const empty = { song: '', artist: '', confidence: 0 }
  if (!rawTitle || typeof rawTitle !== 'string') return empty

  let t = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim()
  t = stripSiteSuffix(t)
  if (!t) return empty

  const artists = knownArtists.filter((a) => typeof a === 'string' && a.length >= 2)
  const queryArtist = artists.find((a) => query.includes(a)) || ''

  let song = ''
  let artist = ''
  let tier = null

  const book = t.match(/《([^》]+)》/u)
  if (book) {
    // 歌手《歌名》…  or  …《歌名》_歌手
    song = book[1].trim()
    const before = t.slice(0, book.index).replace(/[_\-—|]/gu, ' ').trim()
    const after = t.slice(book.index + book[0].length)
    ;({ artist, tier } = pickArtist([before, ...segments(after)], artists, queryArtist))
  } else {
    // Song ends at the earliest tab-keyword OR opening bracket — so
    // "晴天（周杰伦原版吉他谱…）" cuts at "（", not at 吉他谱 (which sits
    // inside the parens). Artist candidates come from BOTH what follows
    // the keyword (echangwang/jitabang) and what's inside the
    // brackets (jitashe buries the artist there).
    const kw = t.match(TAB_KW)
    const bracketIdx = t.search(/[（(【[]/u)
    const boundary = Math.min(
      kw ? kw.index : Infinity,
      bracketIdx < 0 ? Infinity : bracketIdx
    )
    song =
      boundary === Infinity
        ? stripBrackets(segments(t)[0] || t)
        : t.slice(0, boundary).trim()

    const tail = kw ? t.slice(kw.index + kw[0].length) : ''
    const inBrackets = [...t.matchAll(/[（(【[]([^）)】\]]*)[）)】\]]/gu)]
      .map((m) => m[1])
      .join(' ')
    ;({ artist, tier } = pickArtist(
      [...segments(tail), ...segments(inBrackets)],
      artists,
      queryArtist
    ))
  }

  // Fallback: query artist anywhere in the title, then any known artist
  if (!artist) {
    if (queryArtist && t.includes(queryArtist)) {
      artist = queryArtist
      tier = 'query'
    } else {
      const known = artists.find((a) => t.includes(a))
      if (known) {
        artist = known
        tier = 'known'
      }
    }
  }

  song = stripBrackets(song) || song
  return { song, artist, confidence: artist ? CONF[tier] ?? 0 : 0 }
}
