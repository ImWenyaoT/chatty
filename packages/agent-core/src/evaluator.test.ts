import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEvaluator, type EvaluationResult } from './evaluator.js'

test('createEvaluator wraps a plain function and delegates evaluate', async () => {
  const expected: EvaluationResult = {
    score: 8,
    issues: [],
    suggestions: ['可以更亲切'],
    evaluatorModel: 'gpt-4o-mini',
    promptVersion: 'v1',
  }
  const evaluator = createEvaluator(async () => expected)
  const result = await evaluator.evaluate([{ role: 'user', content: '多少钱' }], '199/天')
  assert.deepEqual(result, expected)
})

test('evaluator forwards history and reply to the wrapped function', async () => {
  let captured: { history: unknown; reply: string } | undefined
  const evaluator = createEvaluator(async (history, reply) => {
    captured = { history, reply }
    return {
      score: 7,
      issues: ['语气偏生硬'],
      suggestions: [],
      evaluatorModel: 'm',
      promptVersion: 'v1',
    }
  })
  await evaluator.evaluate(
    [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在' }],
    '在的',
  )
  assert.ok(captured)
  assert.equal(captured!.reply, '在的')
  assert.deepEqual(captured!.history, [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在' },
  ])
})

test('evaluator result carries optional suggestedReply when provided', async () => {
  const evaluator = createEvaluator(async () => ({
    score: 4,
    issues: ['没答到点'],
    suggestions: ['直接给价'],
    suggestedReply: '这件日租 199 元哦~',
    evaluatorModel: 'm',
    promptVersion: 'v1',
  }))
  const result = await evaluator.evaluate([], '')
  assert.equal(result.suggestedReply, '这件日租 199 元哦~')
  assert.equal(result.score, 4)
})
