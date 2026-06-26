import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentTrace } from '@rental/shared'
import {
  shouldCreateFailureCase,
  deriveFailureCase,
  DEFAULT_FAILURE_SCORE_THRESHOLD,
} from './failure-case-policy.js'
import type { EvaluationResult } from './evaluator.js'

const review = (score: number, issues: string[]): EvaluationResult => ({
  score,
  issues,
  suggestions: [],
  evaluatorModel: 'gpt-4o-mini',
  promptVersion: 'v1',
})

const trace = (): AgentTrace => ({
  id: 'tr-1',
  sessionId: 'sess-1',
  eventType: 'agent_reply_sent',
  input: { question: '多少钱' },
  output: { reply: '不知道' },
  toolCalls: [],
  references: [],
  createdAt: '2026-06-26T00:00:00.000Z',
})

test('shouldCreateFailureCase is true below the default threshold', () => {
  assert.equal(shouldCreateFailureCase(5), true)
})

test('shouldCreateFailureCase is false at or above the default threshold', () => {
  assert.equal(shouldCreateFailureCase(DEFAULT_FAILURE_SCORE_THRESHOLD), false)
  assert.equal(shouldCreateFailureCase(9), false)
})

test('shouldCreateFailureCase honours a custom threshold', () => {
  assert.equal(shouldCreateFailureCase(7, 8), true)
  assert.equal(shouldCreateFailureCase(8, 8), false)
})

test('deriveFailureCase maps trace + review into a candidate without id', () => {
  const fc = deriveFailureCase(trace(), review(3, ['拒绝回答', '态度差']))
  assert.equal(fc.traceId, 'tr-1')
  assert.equal(fc.sessionId, 'sess-1')
  assert.equal(fc.score, 3)
  assert.deepEqual(fc.issues, ['拒绝回答', '态度差'])
  assert.deepEqual(fc.input, { question: '多少钱' })
  assert.deepEqual(fc.output, { reply: '不知道' })
  // Pure function: no id/timestamp fields.
  assert.equal('id' in fc, false)
  assert.equal('createdAt' in fc, false)
})

test('deriveFailureCase tolerates a trace with no output', () => {
  const t = trace()
  t.output = undefined
  const fc = deriveFailureCase(t, review(5, ['空回复']))
  assert.equal(fc.output, undefined)
})
