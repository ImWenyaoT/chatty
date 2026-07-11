import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createKnowledgeRepository,
  createControlPlaneRepository,
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
  type ControlPlaneRepository,
} from '@rental/db'
import {
  recoverCustomerServiceTurns,
  runCustomerServiceTurn,
  type CustomerServiceTurnRepos,
} from './customer-service-turn'

/** Builds in-memory repositories for one Customer Service Turn use-case test. */
function createTestRepos(): CustomerServiceTurnRepos & {
  sessions: SessionRepository
  traces: TraceRepository
  reviews: TraceReviewRepository
  memory: MemoryRepository
  knowledge: KnowledgeRepository
  control: ControlPlaneRepository
} {
  const db = openDatabase(':memory:')
  return {
    sessions: createSessionRepository(db),
    traces: createTraceRepository(db),
    reviews: createTraceReviewRepository(db),
    memory: createMemoryRepository(db),
    knowledge: createKnowledgeRepository(db),
    control: createControlPlaneRepository(db),
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
        mode: 'agents-sdk',
        sdkRunner: async () => ({
          reply: '这款西装每天 199 元。',
          action: { action: 'answer_question', reply: '这款西装每天 199 元。' },
          toolCalls: [],
          toolResults: [],
          outputValidated: true as const,
        }),
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

test('runCustomerServiceTurn persists configuration failure state and trace', async () => {
  const repos = createTestRepos()
  await assert.rejects(
    runCustomerServiceTurn(
      { customerId: 'cx-config', question: '在吗' },
      {
        repos,
        idGenerator: testId,
        llmRuntimeFactory: () => {
          throw new Error('missing key')
        },
      },
    ),
    /missing key/,
  )
  const session = repos.sessions.findByConversation('cx-config:general')
  assert.equal(session?.status, 'failed')
  assert.equal(repos.traces.queryBySession(session?.id ?? '').length, 1)
})

test('runCustomerServiceTurn replays the persisted result for one idempotency key', async () => {
  const repos = createTestRepos()
  let calls = 0
  const options = {
    repos,
    idGenerator: testId,
    idempotencyKey: 'request-replay',
    llmRuntimeFactory: () => ({
      mode: 'agents-sdk' as const,
      sdkRunner: async () => {
        calls += 1
        return {
          reply: '只执行一次',
          action: { action: 'answer_question' as const, reply: '只执行一次' },
          toolCalls: [],
          toolResults: [],
          outputValidated: true as const,
        }
      },
      summary: () => createEmptyLlmSummary(),
    }),
  }
  const first = await runCustomerServiceTurn(
    { customerId: 'cx-replay', question: '重复请求' },
    options,
  )
  const replay = await runCustomerServiceTurn(
    { customerId: 'cx-replay', question: '重复请求' },
    options,
  )
  assert.deepEqual(replay, first)
  assert.equal(calls, 1)
  assert.equal(repos.traces.queryBySession(first.sessionId).length, 1)
})

test('runCustomerServiceTurn persists provider failure before returning an error', async () => {
  const repos = createTestRepos()
  await assert.rejects(
    runCustomerServiceTurn(
      { customerId: 'cx-provider', question: '押金规则是什么' },
      {
        repos,
        idGenerator: testId,
        llmRuntimeFactory: () => ({
          mode: 'agents-sdk',
          sdkRunner: async () => {
            throw new Error('provider unavailable')
          },
          summary: () => createEmptyLlmSummary(),
        }),
      },
    ),
    /Agents SDK run failed/,
  )
  const session = repos.sessions.findByConversation('cx-provider:general')
  assert.equal(session?.status, 'failed')
  assert.equal(repos.traces.queryBySession(session?.id ?? '').length, 1)
})

test('runCustomerServiceTurn drains busy conversation input in durable FIFO order', async () => {
  const repos = createTestRepos()
  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let sequence = 0
  const dispatched: string[] = []
  const options = {
    repos,
    idGenerator: (prefix: string) => `${prefix}-${++sequence}`,
    queuedTurnDispatcher: async (input: { question: string }) => {
      dispatched.push(input.question)
    },
    llmRuntimeFactory: () => ({
      mode: 'agents-sdk' as const,
      sdkRunner: async () => {
        await firstBlocked
        return {
          reply: '已处理',
          action: { action: 'answer_question' as const, reply: '已处理' },
          toolCalls: [],
          toolResults: [],
          outputValidated: true as const,
        }
      },
      summary: () => createEmptyLlmSummary(),
    }),
  }
  const first = runCustomerServiceTurn(
    { customerId: 'cx-fifo', conversationId: 'conversation-fifo', question: '第一条' },
    options,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  await assert.rejects(
    runCustomerServiceTurn(
      { customerId: 'cx-fifo', conversationId: 'conversation-fifo', question: '第二条' },
      options,
    ),
    /active run/,
  )
  await assert.rejects(
    runCustomerServiceTurn(
      { customerId: 'cx-fifo', conversationId: 'conversation-fifo', question: '第三条' },
      options,
    ),
    /active run/,
  )
  releaseFirst()
  await first
  assert.deepEqual(dispatched, ['第二条', '第三条'])
  assert.equal(repos.control.dequeueConversationEvent('conversation-fifo'), undefined)
})

test('runCustomerServiceTurn releases a queued input when automatic dispatch fails', async () => {
  const repos = createTestRepos()
  repos.control.enqueueConversationEvent('conversation-retry', 'event-retry', {
    eventId: 'event-retry',
    customerId: 'cx-retry',
    conversationId: 'conversation-retry',
    payload: { question: '不能丢失' },
  })
  await assert.rejects(
    runCustomerServiceTurn(
      { customerId: 'cx-retry', conversationId: 'conversation-retry', question: '当前输入' },
      {
        repos,
        idGenerator: testId,
        queuedTurnDispatcher: async () => {
          throw new Error('dispatcher crashed')
        },
        llmRuntimeFactory: () => ({
          mode: 'agents-sdk',
          sdkRunner: async () => ({
            reply: '已处理',
            action: { action: 'answer_question', reply: '已处理' },
            toolCalls: [],
            toolResults: [],
            outputValidated: true as const,
          }),
          summary: () => createEmptyLlmSummary(),
        }),
      },
    ),
    /dispatcher crashed/,
  )
  assert.equal(
    (repos.control.claimConversationEvent('conversation-retry')?.event as { eventId: string })
      .eventId,
    'event-retry',
  )
})

test('recoverCustomerServiceTurns re-enters an expired run after reopening temporary SQLite', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chatty-recovery-')), 'control.sqlite')
  const firstDb = openDatabase(path)
  const firstControl = createControlPlaneRepository(firstDb)
  firstControl.startRun({
    id: 'run-recovery',
    sessionId: 'session-recovery',
    conversationId: 'conversation-recovery',
    idempotencyKey: 'event-recovery',
  })
  firstControl.appendRunEvent('run-recovery', 'scheduled', {
    eventId: 'event-recovery',
    customerId: 'cx-recovery',
    conversationId: 'conversation-recovery',
    payload: { question: '恢复这条消息' },
  })
  firstControl.claimRun('run-recovery', 'crashed-worker', '2020-01-01T00:00:00.000Z', 1)
  firstDb.close()

  const db = openDatabase(path)
  const repos = {
    sessions: createSessionRepository(db),
    traces: createTraceRepository(db),
    memory: createMemoryRepository(db),
    knowledge: createKnowledgeRepository(db),
    control: createControlPlaneRepository(db),
  }
  const recovered = await recoverCustomerServiceTurns({
    repos,
    idGenerator: testId,
    now: () => '2026-07-11T00:00:00.000Z',
    llmRuntimeFactory: () => ({
      mode: 'agents-sdk',
      sdkRunner: async () => ({
        reply: '恢复成功',
        action: { action: 'answer_question', reply: '恢复成功' },
        toolCalls: [],
        toolResults: [],
        outputValidated: true as const,
      }),
      summary: () => createEmptyLlmSummary(),
    }),
  })
  assert.deepEqual(recovered, ['run-recovery'])
  assert.equal(repos.control.getRun('run-recovery')?.status, 'completed')
  assert.equal(
    (repos.control.getRun('run-recovery')?.result as { reply: string }).reply,
    '恢复成功',
  )
  db.close()
})

test('runCustomerServiceTurn re-enters multiple durable FIFO inputs through the real turn seam', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chatty-fifo-')), 'control.sqlite')
  const db = openDatabase(path)
  const repos = {
    sessions: createSessionRepository(db),
    traces: createTraceRepository(db),
    memory: createMemoryRepository(db),
    knowledge: createKnowledgeRepository(db),
    control: createControlPlaneRepository(db),
  }
  for (const [index, question] of ['第二条', '第三条'].entries()) {
    repos.control.enqueueConversationEvent('conversation-real-fifo', `queued-${index}`, {
      eventId: `queued-${index}`,
      customerId: 'cx-real-fifo',
      conversationId: 'conversation-real-fifo',
      payload: { question },
    })
  }
  let sequence = 0
  let calls = 0
  await runCustomerServiceTurn(
    { customerId: 'cx-real-fifo', conversationId: 'conversation-real-fifo', question: '第一条' },
    {
      repos,
      idGenerator: (prefix) => `${prefix}-${++sequence}`,
      llmRuntimeFactory: () => ({
        mode: 'agents-sdk',
        sdkRunner: async () => {
          calls += 1
          return {
            reply: `回复-${calls}`,
            action: { action: 'answer_question', reply: `回复-${calls}` },
            toolCalls: [],
            toolResults: [],
            outputValidated: true as const,
          }
        },
        summary: () => createEmptyLlmSummary(),
      }),
    },
  )
  assert.equal(calls, 3)
  const session = repos.sessions.findByConversation('conversation-real-fifo')
  assert.equal(repos.traces.queryBySession(session?.id ?? '').length, 3)
  assert.equal(repos.control.claimConversationEvent('conversation-real-fifo'), undefined)
  db.close()
})

/** Builds the zero-usage telemetry summary used by deterministic use-case tests. */
function createEmptyLlmSummary() {
  return {
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
  }
}
