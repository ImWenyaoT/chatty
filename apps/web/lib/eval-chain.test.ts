import assert from 'node:assert/strict'
import test from 'node:test'
import type { EvaluationResult, Evaluator } from '@rental/agent-core'
import {
  createFailureCaseRepository,
  createSessionRepository,
  createTraceRepository,
  createTraceReviewRepository,
  openDatabase,
} from '@rental/db'
import { runTraceEvaluation } from './eval-chain'

/** 起一套 :memory: SQLite 仓储并预置 session，返回评测链需要的全部句柄。 */
function freshRepos() {
  const db = openDatabase(':memory:')
  const sessions = createSessionRepository(db)
  const traces = createTraceRepository(db)
  const reviews = createTraceReviewRepository(db)
  const failures = createFailureCaseRepository(db)
  sessions.create({ id: 'sess-1', customerId: 'c1', conversationId: 'c1:SUIT-001' })
  return { traces, reviews, failures }
}

/** 造一个返回固定评分的 fake evaluator，并记录每次调用的入参。 */
function fakeEvaluator(score: number) {
  const calls: Array<{ history: Array<{ role: string; content: string }>; reply: string }> = []
  const result: EvaluationResult = {
    score,
    issues: score < 6 ? ['拒绝回答'] : [],
    suggestions: ['给出具体价格'],
    suggestedReply: '日租 199 元',
    evaluatorModel: 'fake-judge',
    promptVersion: 'v-test',
  }
  const evaluator: Evaluator = {
    evaluate: async (history, reply) => {
      calls.push({ history, reply })
      return result
    },
  }
  return { evaluator, calls, result }
}

/** 往 traces 里塞一条可评测形状（input.question / output.reply）的 trace。 */
function appendTrace(repos: ReturnType<typeof freshRepos>, id: string, reply?: string) {
  return repos.traces.append({
    id,
    sessionId: 'sess-1',
    eventType: 'agent_reply_sent',
    input: { question: '多少钱' },
    output: reply === undefined ? undefined : { reply },
  })
}

test('eval chain: review lands in trace_reviews with evaluator fields', async () => {
  const repos = freshRepos()
  const trace = appendTrace(repos, 'tr-1', '日租 199 元')
  const { evaluator, calls } = fakeEvaluator(9)

  const outcome = await runTraceEvaluation(
    repos,
    { trace, history: [{ role: 'user', content: '多少钱' }], reply: '日租 199 元' },
    { hasEvaluatorKey: () => true, loadEvaluator: async () => evaluator },
  )

  assert.equal(outcome.status, 'evaluated')
  assert.equal(outcome.reviewed, 1)
  assert.equal(outcome.failures, 0)
  const persisted = repos.reviews.findByTrace('tr-1')
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].score, 9)
  assert.equal(persisted[0].evaluatorModel, 'fake-judge')
  assert.equal(persisted[0].promptVersion, 'v-test')
  assert.deepEqual(calls[0], {
    history: [{ role: 'user', content: '多少钱' }],
    reply: '日租 199 元',
  })
  assert.equal(repos.failures.findOpen().length, 0)
})

test('eval chain: low score promotes a failure case carrying trace input/output', async () => {
  const repos = freshRepos()
  const trace = appendTrace(repos, 'tr-low', '不知道')
  const { evaluator } = fakeEvaluator(3)

  const outcome = await runTraceEvaluation(
    repos,
    { trace, history: [{ role: 'user', content: '多少钱' }], reply: '不知道' },
    { hasEvaluatorKey: () => true, loadEvaluator: async () => evaluator },
  )

  assert.equal(outcome.failures, 1)
  const open = repos.failures.findOpen()
  assert.equal(open.length, 1)
  assert.equal(open[0].traceId, 'tr-low')
  assert.equal(open[0].score, 3)
  assert.deepEqual(open[0].issues, ['拒绝回答'])
  assert.deepEqual(open[0].input, { question: '多少钱' })
})

test('eval chain: missing key skips silently without loading the evaluator', async () => {
  const repos = freshRepos()
  const trace = appendTrace(repos, 'tr-nokey', '日租 199 元')
  let loaderCalled = false

  const outcome = await runTraceEvaluation(
    repos,
    { trace, history: [], reply: '日租 199 元' },
    {
      hasEvaluatorKey: () => false,
      loadEvaluator: async () => {
        loaderCalled = true
        throw new Error('should not be called')
      },
    },
  )

  assert.equal(outcome.status, 'skipped_no_key')
  assert.equal(loaderCalled, false)
  assert.equal(repos.reviews.findByTrace('tr-nokey').length, 0)
  assert.equal(repos.failures.findOpen().length, 0)
})

test('eval chain: unavailable evaluator (no rag-service build) skips without throwing', async () => {
  const repos = freshRepos()
  const trace = appendTrace(repos, 'tr-noeval', '日租 199 元')

  const outcome = await runTraceEvaluation(
    repos,
    { trace, history: [], reply: '日租 199 元' },
    { hasEvaluatorKey: () => true, loadEvaluator: async () => undefined },
  )

  assert.equal(outcome.status, 'skipped_no_evaluator')
  assert.equal(repos.reviews.findByTrace('tr-noeval').length, 0)
})

test('eval chain: backfills backlog traces newest-first and skips unevaluable shapes', async () => {
  const repos = freshRepos()
  appendTrace(repos, 'tr-old-1', '有货的')
  appendTrace(repos, 'tr-old-2', '可以租')
  appendTrace(repos, 'tr-old-3', '押金 500')
  appendTrace(repos, 'tr-noreply') // output 为空，不可评测，应被跳过
  const trace = appendTrace(repos, 'tr-now', '日租 199 元')
  const { evaluator, calls } = fakeEvaluator(8)

  const outcome = await runTraceEvaluation(
    repos,
    { trace, history: [{ role: 'user', content: '多少钱' }], reply: '日租 199 元' },
    { hasEvaluatorKey: () => true, loadEvaluator: async () => evaluator },
  )

  // 补评窗口 newest-first 取 2 条：tr-noreply（形状不可评测，跳过）+ tr-old-3（评上）
  assert.equal(outcome.reviewed, 2)
  assert.equal(calls.length, 2)
  assert.equal(repos.reviews.findByTrace('tr-now').length, 1)
  assert.equal(repos.reviews.findByTrace('tr-old-3').length, 1)
  assert.equal(repos.reviews.findByTrace('tr-noreply').length, 0)
  assert.deepEqual(
    repos.traces.findUnevaluated().map((t) => t.id),
    ['tr-noreply', 'tr-old-2', 'tr-old-1'],
  )
})
