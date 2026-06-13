// ============================================================
// parse-title.test.mjs — node --test
//
// Real-world result titles sampled from each source site (see the
// comment on each case). parseTabTitle must pull a clean song name
// out of all of them, and an artist when one is confidently present.
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTabTitle } from './parse-title.mjs'

// Stand-in for the caller's artist vocabulary (ARTISTS table ∪ local
// library artists ∪ query tokens). Kept small + explicit per test.
const COMMON = ['周杰伦', '五月天', '赵雷', '马良', '烟把儿乐队', '梁静茹']

// AUTO_FILL threshold mirrors the UI: ≥0.75 prefills, below only hints
const AUTO = 0.75

test('echangwang: 歌名吉他谱_歌手_调式', () => {
  const r = parseTabTitle('晴天吉他谱_周杰伦_G调弹唱谱_吉他演示视频', {
    knownArtists: COMMON,
  })
  assert.equal(r.song, '晴天')
  assert.equal(r.artist, '周杰伦')
  assert.ok(r.confidence >= AUTO, `confidence ${r.confidence} should auto-fill`)
})

test('echangwang: 歌手《歌名》吉他谱', () => {
  const r = parseTabTitle('周杰伦《晴天》吉他谱_G调_弹唱六线谱', { knownArtists: COMMON })
  assert.equal(r.song, '晴天')
  assert.equal(r.artist, '周杰伦')
  assert.ok(r.confidence >= AUTO)
})

test('echangwang: 指弹谱变体', () => {
  const r = parseTabTitle('晴天指弹谱_周杰伦_简单版', { knownArtists: COMMON })
  assert.equal(r.song, '晴天')
  assert.equal(r.artist, '周杰伦')
})

test('jitabang: 歌手夹在中间段', () => {
  const r = parseTabTitle('倔强吉他谱_G调原版_五月天_高清弹唱六线谱', { knownArtists: COMMON })
  assert.equal(r.song, '倔强')
  assert.equal(r.artist, '五月天')
  assert.ok(r.confidence >= AUTO)
})

test('dapula: 歌手《歌名》_类型', () => {
  const r = parseTabTitle('五月天《倔强》_尤克里里谱', { knownArtists: COMMON })
  assert.equal(r.song, '倔强')
  assert.equal(r.artist, '五月天')
  assert.ok(r.confidence >= AUTO)
})

test('17jita: 空格分隔 + 站名后缀 (词表命中)', () => {
  const r = parseTabTitle(
    '往后余生吉他谱 马良 C调高清弹唱谱 悠音吉他课堂_图片谱_17吉他网',
    { knownArtists: COMMON }
  )
  assert.equal(r.song, '往后余生')
  assert.equal(r.artist, '马良')
  assert.ok(r.confidence >= AUTO)
})

test('17jita: 词表未命中 → 仅建议 (中置信)', () => {
  // 烟把儿乐队 NOT in knownArtists here: still guessed, but below the
  // auto-fill threshold so the UI only shows it as a hint.
  const r = parseTabTitle(
    '纸短情长吉他谱 烟把儿乐队 C调高清弹唱谱【视频演示】_图片谱_17吉他网',
    { knownArtists: ['周杰伦'] }
  )
  assert.equal(r.song, '纸短情长')
  assert.equal(r.artist, '烟把儿乐队')
  assert.ok(r.confidence > 0 && r.confidence < AUTO, `got ${r.confidence}`)
})

test('jitashe: 括号内含歌手 (词表命中)', () => {
  const r = parseTabTitle('晴天（周杰伦原版吉他谱酷弹乐器）', { knownArtists: COMMON })
  assert.equal(r.song, '晴天')
  assert.equal(r.artist, '周杰伦')
})

test('jitashe: 括号内无歌手 → artist 空', () => {
  const r = parseTabTitle('成都(C调中级版原版吉他谱&amp;教学视频 酷音小伟吉他教学)', {
    knownArtists: COMMON,
  })
  assert.equal(r.song, '成都')
  assert.equal(r.artist, '')
  assert.equal(r.confidence, 0)
})

test('query 拆出的歌手优先 (title 含之)', () => {
  const r = parseTabTitle('成都（纵玩乐器版吉他谱）', {
    query: '赵雷 成都',
    knownArtists: COMMON,
  })
  assert.equal(r.song, '成都')
  // title 不含「赵雷」→ 不应硬塞；保持空，避免错填
  assert.equal(r.artist, '')
})

test('query 歌手在 title 中出现 → 强认', () => {
  const r = parseTabTitle('赵雷成都吉他谱C调', { query: '赵雷 成都', knownArtists: COMMON })
  assert.equal(r.artist, '赵雷')
  assert.ok(r.confidence >= AUTO)
})

test('站名后缀剥离不跨段吃掉中间歌手 (回归)', () => {
  // "…吉他教学" suffix must strip only the trailing segment, not span
  // underscores back into "_周杰伦_简单版_".
  const r = parseTabTitle('晴天指弹谱_周杰伦_简单版_《晴天》指弹吉他教学', {
    knownArtists: COMMON,
  })
  assert.equal(r.song, '晴天')
  assert.equal(r.artist, '周杰伦')
})

test('空标题不炸', () => {
  const r = parseTabTitle('', { knownArtists: COMMON })
  assert.equal(r.song, '')
  assert.equal(r.artist, '')
  assert.equal(r.confidence, 0)
})
