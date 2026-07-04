// 入口契约 schema 的单元测试：legacyChatInputSchema 是 /api/playground 的第一道
// 闸门，这里把「文字/图片至少给一样」的 refine 语义固定下来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacyChatInputSchema } from './schemas.js'

test('legacyChatInputSchema：纯文字提问通过', () => {
  const result = legacyChatInputSchema.safeParse({ customerId: 'c1', question: '这件多少钱' })
  assert.ok(result.success)
  assert.equal(result.data.question, '这件多少钱')
})

test('legacyChatInputSchema：只发图片（question 为空串 + imageUrl）也通过', () => {
  const result = legacyChatInputSchema.safeParse({
    customerId: 'c1',
    question: '',
    imageUrl: 'https://example.com/fit.png',
  })
  assert.ok(result.success)
})

test('legacyChatInputSchema：文字（含纯空白）和图片都缺时被 refine 拒绝', () => {
  const result = legacyChatInputSchema.safeParse({ customerId: 'c1', question: '   ' })
  assert.ok(!result.success)
  assert.match(result.error.issues[0].message, /至少要提供一项/)
})

test('legacyChatInputSchema：customerId 缺失被拒绝', () => {
  const result = legacyChatInputSchema.safeParse({ question: '这件多少钱' })
  assert.ok(!result.success)
})

test('legacyChatInputSchema：sessionContext 只收原始类型，嵌套对象被拒绝', () => {
  const result = legacyChatInputSchema.safeParse({
    customerId: 'c1',
    question: '在吗',
    sessionContext: { heightCm: 175, vip: true, nested: { no: 'way' } },
  })
  assert.ok(!result.success)
})
