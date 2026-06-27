import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createKnowledgeAdapter,
  type KnowledgeHit,
  type KnowledgeQuery,
} from './knowledge-adapter.js'

test('createKnowledgeAdapter delegates search to the wrapped function', async () => {
  const expected: KnowledgeHit[] = [
    { score: 0.9, payload: { text: '日租 199 元', title: '定价规则' } },
  ]
  const adapter = createKnowledgeAdapter(async () => expected)
  const result = await adapter.search({ question: '多少钱' })
  assert.deepEqual(result, expected)
})

test('adapter forwards the full KnowledgeQuery to the wrapped function', async () => {
  let captured: KnowledgeQuery | undefined
  const adapter = createKnowledgeAdapter(async (q) => {
    captured = q
    return []
  })
  await adapter.search({ question: '怎么洗', topK: 5, sourceType: 'product' })
  assert.ok(captured)
  assert.equal(captured!.question, '怎么洗')
  assert.equal(captured!.topK, 5)
  assert.equal(captured!.sourceType, 'product')
})

test('adapter tolerates a query with only the question', async () => {
  const adapter = createKnowledgeAdapter(async () => [
    { score: 0.5, payload: 'plain payload' },
  ])
  const result = await adapter.search({ question: 'hi' })
  assert.equal(result.length, 1)
  assert.equal(result[0].payload, 'plain payload')
})
