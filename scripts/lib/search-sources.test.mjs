// ============================================================
// search-sources.test.mjs — node --test
//
// Parser contract tests: each fixture mirrors the real result markup
// of one source (anchors, lazy-load attrs, GBK <font> wrapping). They
// lock the regex against silent breakage — if a site changes structure
// the parser returns [], and these go red. Source-resolution tests
// cover the filter whitelist.
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseJitashe,
  parseEchangwang,
  parseJitabang,
  parseDapula,
  parseShaomingyang,
  parseJitahome,
  resolveSearchableSources,
  isAllowedThumbHost,
  SOURCE_LIST,
} from './search-sources.mjs'

test('parseJitashe: 锚文本即标题，相对链接', () => {
  const html = `
    <ul>
      <li><a href="/tab/12345/">晴天（周杰伦原版吉他谱酷弹乐器）</a></li>
      <li><a href="/tab/678">倔强（五月天5525跨年演唱会）</a></li>
    </ul>`
  const out = parseJitashe(html)
  assert.equal(out.length, 2)
  assert.equal(out[0].pageUrl, 'https://www.jitashe.org/tab/12345/')
  assert.equal(out[0].title, '晴天（周杰伦原版吉他谱酷弹乐器）')
  assert.equal(out[0].thumbnail, null)
})

test('parseEchangwang: 绝对链接 + <font> 包裹命中词', () => {
  const html = `
    <a href="http://www.echangwang.com/pic/123/456.html" target="_blank">晴天吉他谱_<font color="red">周杰伦</font>_G调弹唱谱</a>
    <a href="http://www.echangwang.com/tab/9/9.html">周杰伦《晴天》吉他谱_G调_弹唱六线谱</a>`
  const out = parseEchangwang(html)
  assert.equal(out.length, 2)
  assert.equal(out[0].pageUrl, 'http://www.echangwang.com/pic/123/456.html')
  assert.equal(out[0].title, '晴天吉他谱_周杰伦_G调弹唱谱') // tags stripped
})

test('parseJitabang: 缩略图在 data-original（src 是占位）', () => {
  const html = `
    <a class="item-img-inner" href="https://www.jitabang.com/jitapu/789.html" title="倔强吉他谱_G调原版_五月天_高清弹唱六线谱">
      <img class="lazy" src="https://www.jitabang.com/lazy.png" data-original="https://www.jitabang.com/wp/thumb.jpg">
    </a>`
  const out = parseJitabang(html)
  assert.equal(out.length, 1)
  assert.equal(out[0].pageUrl, 'https://www.jitabang.com/jitapu/789.html')
  assert.equal(out[0].title, '倔强吉他谱_G调原版_五月天_高清弹唱六线谱')
  assert.equal(out[0].thumbnail, 'https://www.jitabang.com/wp/thumb.jpg')
})

test('parseDapula: 标题在 img alt，链接相对', () => {
  const html = `
    <a href="/show/55.html"><img src="/uploads/t.jpg" alt="五月天《倔强》_尤克里里谱"></a>`
  const out = parseDapula(html)
  assert.equal(out.length, 1)
  assert.equal(out[0].pageUrl, 'https://www.dapula.com/show/55.html')
  assert.equal(out[0].title, '五月天《倔强》_尤克里里谱')
  assert.equal(out[0].thumbnail, 'https://www.dapula.com/uploads/t.jpg')
})

test('parseShaomingyang: DedeCMS focus 锚 + 缩略图，piano 行被丢', () => {
  // Real-structure: alt/title wrap the matched term in <font>; the
  // search mixes guitar (/btb/) and piano (/gangqinpu/) rows — only
  // guitar should survive.
  const html = `
    <article class="excerpt excerpt-1"> <a href="http://www.shaomingyang.com/btb/35038.html" class="focus" target="_blank"><img alt="<font color='red'>晴天</font>E调版" class="thumb lazy" src="http://www.shaomingyang.com/uploads/allimg/260415/1_0415113T13264.jpg"/></a>
      <header><a href="http://www.shaomingyang.com/btb/" class="cat">吉他谱</a>
        <h2><a href="http://www.shaomingyang.com/btb/35038.html" title="<b><font color='red'>晴天</font>E调版</b>"><b><font color='red'>晴天</font>E调版</b></a></h2></header></article>
    <article class="excerpt excerpt-1"> <a href="http://www.shaomingyang.com/gangqinpu/35240.html" class="focus"><img alt="晴天钢琴谱" class="thumb lazy" src="http://www.shaomingyang.com/uploads/allimg/x.jpg"/></a></article>`
  const out = parseShaomingyang(html)
  assert.equal(out.length, 1) // piano row dropped
  assert.equal(out[0].pageUrl, 'http://www.shaomingyang.com/btb/35038.html')
  assert.equal(out[0].title, '晴天E调版') // <font> stripped
  assert.equal(out[0].thumbnail, 'http://www.shaomingyang.com/uploads/allimg/260415/1_0415113T13264.jpg')
})

test('parseJitahome: 缩略图锚与标题锚按 href 配对', () => {
  // The thumbnail anchor and the title anchor are separate elements
  // sharing the same /<id>.html href; the parser joins them.
  const html = `
    <div class="jth-article-item">
      <a class="list-item-img" href="https://www.jitahome.com/9722.html" target="_blank">
        <img src="https://cdn.jitahome.com/public/abc.jpg?x-oss-process=image/resize,m_fill,h_372,w_600"></a>
      <h2 class="list-item-title">
        <a href="https://www.jitahome.com/9722.html" target="_blank">淘汰吉他谱_陈奕迅_G调编配吉他伴奏谱</a></h2>
    </div>`
  const out = parseJitahome(html)
  assert.equal(out.length, 1)
  assert.equal(out[0].pageUrl, 'https://www.jitahome.com/9722.html')
  assert.equal(out[0].title, '淘汰吉他谱_陈奕迅_G调编配吉他伴奏谱')
  assert.equal(
    out[0].thumbnail,
    'https://cdn.jitahome.com/public/abc.jpg?x-oss-process=image/resize,m_fill,h_372,w_600'
  )
})

test('parser 对空/无关 HTML 返回 []', () => {
  for (const parse of [
    parseJitashe,
    parseEchangwang,
    parseJitabang,
    parseDapula,
    parseShaomingyang,
    parseJitahome,
  ]) {
    assert.deepEqual(parse('<html><body>nothing</body></html>'), [])
  }
})

// ------------------------------------------------------------
// Thumbnail-proxy host allowlist — the proxy must only fetch from
// known tab-site hosts/CDNs, never an arbitrary URL (open-proxy /
// SSRF amplification guard).
// ------------------------------------------------------------
test('isAllowedThumbHost: 谱站主域与 CDN 子域放行', () => {
  assert.ok(isAllowedThumbHost('https://www.jitabang.com/img/x.jpg'))
  assert.ok(isAllowedThumbHost('https://cdn.jitahome.com/public/x.jpg')) // CDN subdomain
  assert.ok(isAllowedThumbHost('http://www.shaomingyang.com/uploads/allimg/x.jpg'))
  assert.ok(isAllowedThumbHost('https://static.jitashe.org/x.png'))
})

test('isAllowedThumbHost: 站外/伪装域名拦截', () => {
  assert.ok(!isAllowedThumbHost('https://evil.com/x.jpg'))
  assert.ok(!isAllowedThumbHost('https://jitabang.com.evil.com/x.jpg')) // suffix spoof
  assert.ok(!isAllowedThumbHost('not a url'))
  assert.ok(!isAllowedThumbHost('http://169.254.169.254/latest/meta-data/'))
})

// ------------------------------------------------------------
// Source resolution (filter whitelist)
// ------------------------------------------------------------
const ALL = SOURCE_LIST.filter((s) => s.searchable).map((s) => s.id)

test('无请求 → 所有可搜索源', () => {
  assert.deepEqual(resolveSearchableSources(undefined), ALL)
  assert.deepEqual(resolveSearchableSources([]), ALL)
})

test('子集 → 只跑请求内的源', () => {
  assert.deepEqual(resolveSearchableSources(['jitashe']), ['jitashe'])
})

test('未知 id 被丢弃，不报错', () => {
  assert.deepEqual(resolveSearchableSources(['jitashe', 'bogus']), ['jitashe'])
  assert.deepEqual(resolveSearchableSources(['bogus']), [])
})

test('新增免费源入列：绵羊乐谱 + 吉他园地', () => {
  for (const id of ['shaomingyang', 'jitahome']) {
    const s = SOURCE_LIST.find((x) => x.id === id)
    assert.ok(s, `${id} 应在 SOURCE_LIST`)
    assert.equal(s.free, true)
    assert.equal(s.searchable, true)
    assert.ok(resolveSearchableSources([id]).includes(id))
  }
})
