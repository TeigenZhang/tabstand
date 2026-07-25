import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drawFromBag, poolKey } from './shuffle-bag.mjs'

const id = (x) => x

test('单池：抽满整池前不重复', () => {
  const pool = ['a1', 'a2', 'a3', 'a4', 'a5']
  const bag = new Set()
  const picks = []
  let prev = null
  for (let i = 0; i < pool.length; i++) {
    prev = drawFromBag(bag, pool, prev, id)
    picks.push(prev)
  }
  assert.equal(new Set(picks).size, pool.length, '一整轮应覆盖全部且不重复')
})

test('池大于 1 时永不连续重复同一首', () => {
  const pool = ['a1', 'a2', 'a3', 'a4', 'a5']
  const bag = new Set()
  let prev = null
  for (let i = 0; i < 300; i++) {
    const pick = drawFromBag(bag, pool, prev, id)
    assert.notEqual(pick, prev, `第 ${i} 次连续重复了 ${pick}`)
    prev = pick
  }
})

// Guards against the recency-map regression: after round 1 the order must NOT
// be a permanent fixed rotation. Different rng → different second-round order.
test('每一轮都重新随机，不退化为固定循环', () => {
  const pool = ['a', 'b', 'c', 'd', 'e']
  const round = (rng) => {
    const bag = new Set()
    const out = []
    let prev = null
    for (let i = 0; i < pool.length; i++) {
      prev = drawFromBag(bag, pool, prev, id, rng)
      out.push(prev)
    }
    return out.join('')
  }
  // Two different random sources should be able to produce different orders.
  const seqs = new Set()
  let seed = 1
  const lcg = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let t = 0; t < 20; t++) seqs.add(round(lcg))
  assert.ok(seqs.size > 1, '多轮随机应产生不止一种顺序（非固定循环）')
})

// The real UI overlap: 所有 = 弹唱 ∪ 指弹. Separate bags → exhausting the child
// pool must not cause a premature repeat in the overlapping parent pool.
test('重叠池独立：抽空子池不影响父池的无重复', () => {
  const STRUM = ['s1', 's2', 's3', 's4', 's5'] // 弹唱
  const ALL = ['s1', 's2', 's3', 's4', 's5', 'f1', 'f2', 'f3'] // 所有
  const bags = new Map()
  const bagFor = (k) => {
    if (!bags.has(k)) bags.set(k, new Set())
    return bags.get(k)
  }
  const kStrum = poolKey('我', 'strumming')
  const kAll = poolKey('我', null)
  assert.notEqual(kStrum, kAll, '弹唱与所有应是不同的池')

  // Deal a few from 所有 (parent), then hammer 弹唱 (child) through many cycles
  let prev = null
  const parentSeen = []
  for (let i = 0; i < 3; i++) {
    prev = drawFromBag(bagFor(kAll), ALL, prev, id)
    parentSeen.push(prev)
  }
  for (let i = 0; i < 40; i++) prev = drawFromBag(bagFor(kStrum), STRUM, prev, id)

  // Parent pool must still deal its REMAINING unseen songs before repeating any
  // it already showed — i.e., child churn didn't corrupt the parent bag.
  const parentBag = bagFor(kAll)
  const remaining = ALL.filter((s) => !parentBag.has(s))
  const got = new Set()
  let p = prev
  for (let i = 0; i < remaining.length; i++) {
    p = drawFromBag(parentBag, ALL, p, id)
    got.add(p)
  }
  assert.deepEqual(
    [...got].sort(),
    [...remaining].sort(),
    '父池应先抽完自己未出现过的曲，未被子池搅乱而提前重复'
  )
})

// The consecutive-repeat bug: on a mood switch, prev comes from another pool's
// bag and can be the lone unshown song in the new pool. Must not be re-handed.
test('切换心情时也不连续重复（新池仅剩 prev 未出现）', () => {
  const pool = ['s1', 's2', 's3']
  const bag = new Set(['s1', 's2']) // new pool's bag: only s3 unshown
  const prev = 's3' // current song (from the previous pool) equals the lone unshown
  for (let t = 0; t < 50; t++) {
    const local = new Set(bag)
    const pick = drawFromBag(local, pool, prev, id)
    assert.notEqual(pick, prev, '切换后把当前这首又抛回来了（连续重复）')
  }
})

test('单池抽空的换轮边界也不连续重复', () => {
  const pool = ['a', 'b'] // smallest non-trivial pool — most likely to repeat
  const bag = new Set()
  let prev = null
  for (let i = 0; i < 100; i++) {
    prev = drawFromBag(bag, pool, prev, id)
    if (i > 0) assert.ok(true)
  }
  // re-run asserting each step
  const bag2 = new Set()
  let p = null
  for (let i = 0; i < 100; i++) {
    const next = drawFromBag(bag2, pool, p, id)
    assert.notEqual(next, p, `第 ${i} 次连续重复`)
    p = next
  }
})

test('池键唯一：分隔符无法伪造他池', () => {
  // A role literally named to try to collide with (我, strumming)
  assert.notEqual(poolKey('我', 'strumming'), poolKey('我|strumming', null))
  assert.notEqual(poolKey('a', 'b'), poolKey('a', 'b|c'))
  assert.notEqual(poolKey(null, null), poolKey('*', '*'))
  // Same inputs → same key (stable)
  assert.equal(poolKey('朋友', null), poolKey('朋友', null))
})

test('空池返回 null', () => {
  assert.equal(drawFromBag(new Set(), [], null, id), null)
})
