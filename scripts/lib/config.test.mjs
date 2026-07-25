import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDefaultOwner, FALLBACK_OWNER } from './config.mjs'

// ============================================================
// 默认角色解析 — 一个 fresh clone 必须零配置可跑，且绝不能把
// 某个人的名字当作内置默认。
// ============================================================

test('无配置文件 / 空配置 → 中性内置默认', () => {
  assert.equal(resolveDefaultOwner({}), FALLBACK_OWNER)
  assert.equal(resolveDefaultOwner(null), FALLBACK_OWNER)
  assert.equal(resolveDefaultOwner(undefined), FALLBACK_OWNER)
})

test('内置默认不含任何个人名字', () => {
  // 发布护栏：这条挂了说明有人把自己的角色名写回了源码
  assert.equal(FALLBACK_OWNER, '我')
})

test('配置了 defaultOwner → 覆盖内置默认', () => {
  assert.equal(resolveDefaultOwner({ defaultOwner: '阿明' }), '阿明')
})

test('空白 / 非字符串的 defaultOwner 视为未配置', () => {
  assert.equal(resolveDefaultOwner({ defaultOwner: '   ' }), FALLBACK_OWNER)
  assert.equal(resolveDefaultOwner({ defaultOwner: '' }), FALLBACK_OWNER)
  assert.equal(resolveDefaultOwner({ defaultOwner: 42 }), FALLBACK_OWNER)
  assert.equal(resolveDefaultOwner({ defaultOwner: null }), FALLBACK_OWNER)
})

test('两侧空白被裁掉——否则角色名与 meta.json 里写的对不上', () => {
  assert.equal(resolveDefaultOwner({ defaultOwner: '  阿明  ' }), '阿明')
})
