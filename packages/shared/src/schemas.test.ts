// 入口契约 schema 的单元测试：legacyChatInputSchema 是 /chat 的第一道闸门，
// 这里把「文字/图片至少给一样」的 refine 语义和运行时工具调用契约固定下来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacyChatInputSchema, runtimeToolCallSchema } from './schemas.js'

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

test('runtimeToolCallSchema：合法工具调用（含嵌套 JSON 参数）通过', () => {
  const result = runtimeToolCallSchema.safeParse({
    toolName: 'check_availability',
    arguments: { productId: 'SUIT-001', period: { start: '2026-07-10', end: '2026-07-12' } },
    risk: 'medium',
    approvalRequired: true,
  })
  assert.ok(result.success)
  assert.equal(result.data.risk, 'medium')
})

test('runtimeToolCallSchema：risk 超出 low/medium/high 枚举被拒绝', () => {
  const result = runtimeToolCallSchema.safeParse({
    toolName: 'place_order',
    arguments: {},
    risk: 'critical',
    approvalRequired: true,
  })
  assert.ok(!result.success)
})
