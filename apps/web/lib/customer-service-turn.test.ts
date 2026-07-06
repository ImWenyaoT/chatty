import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createKnowledgeRepository,
  createMemoryRepository,
  createSessionRepository,
  createTraceRepository,
  createTraceReviewRepository,
  openDatabase,
  type KnowledgeRepository,
  type MemoryRepository,
  type SessionRepository,
  type TraceRepository,
  type TraceReviewRepository,
} from '@rental/db'
import { runCustomerServiceTurn, type CustomerServiceTurnRepos } from './customer-service-turn'

/** Builds in-memory repositories for one Customer Service Turn use-case test. */
function createTestRepos(): CustomerServiceTurnRepos & {
  sessions: SessionRepository
  traces: TraceRepository
  reviews: TraceReviewRepository
  memory: MemoryRepository
  knowledge: KnowledgeRepository
} {
  const db = openDatabase(':memory:')
  return {
    sessions: createSessionRepository(db),
    traces: createTraceRepository(db),
    reviews: createTraceReviewRepository(db),
    memory: createMemoryRepository(db),
    knowledge: createKnowledgeRepository(db),
  }
}

/** Deterministic id adapter so the use-case can be tested without random UUIDs. */
function testId(prefix: string): string {
  return `${prefix}_test`
}

test('runCustomerServiceTurn creates session, trace, continuity memory, and response data', async () => {
  const repos = createTestRepos()
  const result = await runCustomerServiceTurn(
    {
      customerId: 'cx-1',
      productId: 'SUIT-001',
      question: '这款多少钱一天？',
      sessionContext: { channel: 'test' },
    },
    {
      repos,
      idGenerator: testId,
      now: () => '2026-07-06T09:00:00.000Z',
      llmRuntimeFactory: () => ({
        mode: 'disabled',
        modelFn: undefined,
        toolLoopFn: undefined,
        summary: () => ({
          model: 'deepseek-v4-pro',
          calls: 0,
          callBudget: 3,
          inputCacheHitTokens: 0,
          inputCacheMissTokens: 0,
          inputCacheHitRatio: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostCny: 0,
          operations: [],
          warnings: [],
        }),
      }),
    },
  )

  assert.equal(result.sessionId, 'sess_test')
  assert.equal(result.traceId, 'tr_test')
  assert.equal(result.status, 'waiting_for_user')
  assert.ok(result.harnessTrace.task)
  assert.ok(result.harnessTrace.llm)
  assert.equal(result.harnessTrace.task.kind, 'answer_question')
  assert.equal(result.harnessTrace.llm.calls, 0)

  const session = repos.sessions.findByConversation('cx-1:SUIT-001')
  assert.equal(session?.id, 'sess_test')
  assert.equal(session?.productId, 'SUIT-001')

  const traces = repos.traces.queryBySession('sess_test')
  assert.equal(traces.length, 1)
  assert.equal(traces[0].id, 'tr_test')
  assert.equal(traces[0].intent, 'answer_question')

  const snapshot = repos.memory.snapshot({
    customerId: 'cx-1',
    conversationId: 'cx-1:SUIT-001',
    productId: 'SUIT-001',
  })
  assert.deepEqual(snapshot.recentMessages, [
    { role: 'user', content: '这款多少钱一天？' },
    { role: 'assistant', content: result.reply },
  ])
})
