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
  resumeCustomerServiceHandoff,
  runCustomerServiceTurn,
  type CustomerServiceTurnRepos,
} from './customer-service-turn'
import { HarnessRunController } from './harness-run-controller'

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

test('resumeCustomerServiceHandoff reopens SQLite and completes through the public turn seam', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chatty-handoff-')), 'control.sqlite')
  const firstDb = openDatabase(path)
  let sequence = 0
  const firstRepos = {
    sessions: createSessionRepository(firstDb),
    traces: createTraceRepository(firstDb),
    memory: createMemoryRepository(firstDb),
    knowledge: createKnowledgeRepository(firstDb),
    control: createControlPlaneRepository(firstDb),
  }
  const handedOff = await runCustomerServiceTurn(
    {
      customerId: 'cx-handoff',
      conversationId: 'conversation-handoff',
      question: '我要人工处理退款',
    },
    {
      repos: firstRepos,
      idGenerator: (prefix) => `${prefix}-handoff-${++sequence}`,
      llmRuntimeFactory: () => ({
        mode: 'agents-sdk',
        sdkRunner: async () => ({
          reply: '已转人工处理。',
          action: {
            action: 'handoff' as const,
            reply: '已转人工处理。',
            toolName: 'create_handoff' as const,
            toolArgs: { conversationId: 'conversation-handoff', reason: '退款' },
          },
          toolCalls: [],
          toolResults: [],
          outputValidated: true as const,
        }),
        summary: () => createEmptyLlmSummary(),
      }),
    },
  )
  assert.equal(firstRepos.control.getRun(handedOff.runId)?.status, 'waiting_for_handoff')
  firstDb.close()

  const resumedDb = openDatabase(path)
  const resumedRepos = {
    sessions: createSessionRepository(resumedDb),
    traces: createTraceRepository(resumedDb),
    memory: createMemoryRepository(resumedDb),
    knowledge: createKnowledgeRepository(resumedDb),
    control: createControlPlaneRepository(resumedDb),
  }
  const resumed = await resumeCustomerServiceHandoff(handedOff.runId, {
    repos: resumedRepos,
    handoffResolution: '这款西装多少钱一天？',
    idGenerator: (prefix) => `${prefix}-resumed-${++sequence}`,
    llmRuntimeFactory: () => ({
      mode: 'agents-sdk',
      sdkRunner: async () => ({
        reply: '人工处理后已恢复自动服务。',
        action: { action: 'answer_question' as const, reply: '人工处理后已恢复自动服务。' },
        toolCalls: [],
        toolResults: [],
        outputValidated: true as const,
      }),
      summary: () => createEmptyLlmSummary(),
    }),
  })

  assert.equal(resumed.runId, handedOff.runId)
  assert.equal(resumedRepos.control.getRun(handedOff.runId)?.status, 'completed')
  assert.ok(
    resumedRepos.control
      .listRunEvents(handedOff.runId)
      .some((event) => event.type === 'handoff_resumed'),
  )
  assert.equal(resumedRepos.traces.queryBySession(resumed.sessionId).length, 2)
  resumedDb.close()
})

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

test('Customer Service Turn checkpoints only the last persisted trace and replays after it', async () => {
  const repos = createTestRepos()
  repos.sessions.create({
    id: 'session-compaction',
    customerId: 'customer-compaction',
    conversationId: 'conversation-compaction',
  })
  for (let index = 1; index <= 5; index += 1) {
    repos.traces.append({
      id: `trace-included-${index}`,
      sessionId: 'session-compaction',
      eventType: 'agent_reply_sent',
      input: { question: `earlier-${index}` },
    })
  }
  repos.memory.appendRecentMessages(
    {
      customerId: 'customer-compaction',
      conversationId: 'conversation-compaction',
      productId: 'general',
    },
    Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `raw-${index}` })),
  )
  let sequence = 0
  let compactedMessages: unknown[] = []
  let replayedMessages: unknown[] = []
  const result = await runCustomerServiceTurn(
    {
      customerId: 'customer-compaction',
      conversationId: 'conversation-compaction',
      question: 'next question',
    },
    {
      repos,
      idGenerator: (prefix) => `${prefix}-compaction-${++sequence}`,
      compactionTokenLimit: 1,
      checkpointGenerator: async (compactionInput) => {
        compactedMessages = compactionInput.recentMessages
        return {
          currentGoal: 'answer next question',
          confirmedFacts: [],
          decisions: [],
          preferences: [],
          workflowState: 'active',
          unresolved: [],
          references: ['trace-included-2'],
        }
      },
      llmRuntimeFactory: () => ({
        mode: 'agents-sdk',
        sdkRunner: async (runtime) => {
          replayedMessages = runtime.memory.recentMessages
          return {
            reply: 'done',
            action: { action: 'answer_question', reply: 'done' },
            toolCalls: [],
            toolResults: [],
            outputValidated: true as const,
          }
        },
        summary: () => createEmptyLlmSummary(),
      }),
    },
  )

  const checkpoint = repos.control.latestCheckpoint('conversation-compaction')
  assert.equal(checkpoint?.throughTraceId, 'trace-included-2')
  assert.deepEqual(
    compactedMessages.map((message) => (message as { content: string }).content),
    ['raw-0', 'raw-1', 'raw-2', 'raw-3'],
  )
  assert.deepEqual(
    replayedMessages.map((message) => (message as { content: string }).content),
    ['raw-4', 'raw-5', 'raw-6', 'raw-7', 'raw-8', 'raw-9'],
  )
  assert.deepEqual(
    repos.traces.queryBySession('session-compaction').map((trace) => trace.id),
    [
      'trace-included-1',
      'trace-included-2',
      'trace-included-3',
      'trace-included-4',
      'trace-included-5',
      result.traceId,
    ],
  )
})

test('Customer Service Turn records non-destructive compaction failure evidence', async () => {
  const repos = createTestRepos()
  repos.sessions.create({
    id: 'session-failed-compaction',
    customerId: 'customer-failed-compaction',
    conversationId: 'conversation-failed-compaction',
  })
  repos.traces.append({
    id: 'trace-before-failure',
    sessionId: 'session-failed-compaction',
    eventType: 'agent_reply_sent',
    input: { question: 'earlier' },
  })
  repos.memory.appendRecentMessages(
    {
      customerId: 'customer-failed-compaction',
      conversationId: 'conversation-failed-compaction',
      productId: 'general',
    },
    Array.from({ length: 8 }, (_, index) => ({ role: 'user', content: `raw-${index}` })),
  )
  const previous = repos.control.saveCheckpoint({
    id: 'checkpoint-before-failure',
    conversationId: 'conversation-failed-compaction',
    throughTraceId: 'trace-before-failure',
    summary: { currentGoal: 'preserve me' },
    tokenBefore: 100,
    tokenAfter: 20,
    model: 'deepseek-v4-pro',
  })
  let sequence = 0
  const result = await runCustomerServiceTurn(
    {
      customerId: 'customer-failed-compaction',
      conversationId: 'conversation-failed-compaction',
      question: 'continue',
    },
    {
      repos,
      idGenerator: (prefix) => `${prefix}-failed-compaction-${++sequence}`,
      compactionTokenLimit: 1,
      checkpointGenerator: async () => {
        throw new Error('provider unavailable')
      },
      llmRuntimeFactory: () => ({
        mode: 'agents-sdk',
        sdkRunner: async () => ({
          reply: 'fallback succeeded',
          action: { action: 'answer_question', reply: 'fallback succeeded' },
          toolCalls: [],
          toolResults: [],
          outputValidated: true as const,
        }),
        summary: () => createEmptyLlmSummary(),
      }),
    },
  )

  assert.deepEqual(repos.control.latestCheckpoint('conversation-failed-compaction'), previous)
  assert.equal(
    repos.control.listRunEvents(result.runId).some((event) => event.type === 'compaction_failed'),
    true,
  )
  assert.equal(repos.control.countRunEventsByType('compaction_failed'), 1)
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

test('runCustomerServiceTurn observes a durable cancel from another controller and fences side effects', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'chatty-cancel-')), 'control.sqlite')
  const workerDb = openDatabase(path)
  const workerRepos = {
    sessions: createSessionRepository(workerDb),
    traces: createTraceRepository(workerDb),
    memory: createMemoryRepository(workerDb),
    knowledge: createKnowledgeRepository(workerDb),
    control: createControlPlaneRepository(workerDb),
  }
  const cancellerDb = openDatabase(path)
  const cancellerControl = createControlPlaneRepository(cancellerDb)
  let executionSignal!: AbortSignal
  const turn = runCustomerServiceTurn(
    { customerId: 'cx-cancel', conversationId: 'conversation-cancel', question: '稍后提醒我' },
    {
      repos: workerRepos,
      idGenerator: (prefix) => `${prefix}-cancel`,
      idempotencyKey: 'request-cancel',
      cancellationPollMs: 5,
      llmRuntimeFactory: () => ({
        mode: 'agents-sdk',
        sdkRunner: async (runtime) => {
          executionSignal = runtime.signal!
          await new Promise<void>((_resolve, reject) => {
            runtime.signal?.addEventListener(
              'abort',
              () => reject(runtime.signal?.reason ?? new Error('cancelled')),
              { once: true },
            )
          })
          throw new Error('unreachable')
        },
        summary: () => createEmptyLlmSummary(),
      }),
    },
  )

  while (!executionSignal) await new Promise((resolve) => setTimeout(resolve, 0))
  const firstCancel = new HarnessRunController(cancellerControl).cancel('run-cancel')
  const repeatedCancel = new HarnessRunController(cancellerControl).cancel('run-cancel')
  assert.equal(firstCancel.cancelRequestedAt !== undefined, true)
  assert.equal(repeatedCancel.cancelRequestedAt, firstCancel.cancelRequestedAt)
  await assert.rejects(turn, /cancel/i)

  assert.equal(executionSignal.aborted, true)
  assert.equal(workerRepos.control.getRun('run-cancel')?.status, 'cancelled')
  assert.equal(workerRepos.traces.queryBySession('sess-cancel').length, 0)
  assert.deepEqual(
    workerRepos.memory.snapshot({
      customerId: 'cx-cancel',
      conversationId: 'conversation-cancel',
    }).recentMessages,
    [],
  )
  assert.equal(workerRepos.control.listJobs().length, 0)
  assert.equal(
    workerRepos.control
      .listRunEvents('run-cancel')
      .filter((event) => event.type === 'cancel_requested').length,
    1,
  )
  cancellerDb.close()
  workerDb.close()
  const restartedDb = openDatabase(path)
  const restartedRepos = {
    sessions: createSessionRepository(restartedDb),
    traces: createTraceRepository(restartedDb),
    memory: createMemoryRepository(restartedDb),
    knowledge: createKnowledgeRepository(restartedDb),
    control: createControlPlaneRepository(restartedDb),
  }
  assert.deepEqual(await recoverCustomerServiceTurns({ repos: restartedRepos }), [])
  assert.equal(restartedRepos.control.getRun('run-cancel')?.status, 'cancelled')
  restartedDb.close()
})

test('a cancelled Customer Service Turn continues the durable FIFO with the next input', async () => {
  const repos = createTestRepos()
  let signal!: AbortSignal
  const dispatched: string[] = []
  const turn = runCustomerServiceTurn(
    {
      customerId: 'cx-cancel-fifo',
      conversationId: 'conversation-cancel-fifo',
      question: '第一条',
    },
    {
      repos,
      idGenerator: (prefix) => `${prefix}-cancel-fifo`,
      cancellationPollMs: 5,
      queuedTurnDispatcher: async (input) => {
        dispatched.push(input.question)
      },
      llmRuntimeFactory: () => ({
        mode: 'agents-sdk',
        sdkRunner: async (runtime) => {
          signal = runtime.signal!
          await new Promise<void>((_resolve, reject) =>
            runtime.signal?.addEventListener('abort', () => reject(runtime.signal?.reason), {
              once: true,
            }),
          )
          throw new Error('unreachable')
        },
        summary: () => createEmptyLlmSummary(),
      }),
    },
  )
  while (!signal) await new Promise((resolve) => setTimeout(resolve, 0))
  repos.control.enqueueConversationEvent('conversation-cancel-fifo', 'queued-after-cancel', {
    eventId: 'queued-after-cancel',
    customerId: 'cx-cancel-fifo',
    conversationId: 'conversation-cancel-fifo',
    payload: { question: '第二条' },
  })
  new HarnessRunController(repos.control).cancel('run-cancel-fifo')
  await assert.rejects(turn, /cancel/i)
  assert.deepEqual(dispatched, ['第二条'])
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
