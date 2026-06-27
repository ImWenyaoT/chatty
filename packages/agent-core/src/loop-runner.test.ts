import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationEvent } from '@rental/shared'
import type { AgentContext } from './loop-contracts.js'
import { createLoopRunner } from './loop-runner.js'

// A no-op memory snapshot; the loop only reads event/question in MVP.
const emptyMemory = {
  customerId: 'c',
  conversationId: 'c:SUIT-001',
  recentMessages: [],
}

function userEvent(question: string, extra: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    eventId: 'e1',
    type: 'user_message',
    customerId: 'c',
    conversationId: 'c:SUIT-001',
    productId: 'SUIT-001',
    source: 'customer',
    payload: { question },
    occurredAt: '2026-06-25T00:00:00.000Z',
    ...extra,
  }
}

function ctx(question: string, extra?: Partial<ConversationEvent>): AgentContext {
  return { event: userEvent(question, extra), memory: emptyMemory }
}

// Fake classifier injected via options.classify — no network needed.
const classify = (actionClass: string, reply?: string) => async () => ({ actionClass, reason: 'test', reply })

test('small_talk: direct reply, no tools, waiting_for_user', async () => {
  const runner = createLoopRunner({
    llm: fakeLlm(),
    classify: classify('small_talk', '你好呀'),
  })
  const result = await runner.runStep(ctx('你好'))
  assert.equal(result.terminality, 'reply_and_wait')
  assert.equal(result.reply, '你好呀')
  assert.equal(result.nextStatus, 'waiting_for_user')
  assert.deepEqual(result.toolCalls, [])
})

test('provide_info: direct acknowledgement reply', async () => {
  const runner = createLoopRunner({
    llm: fakeLlm(),
    classify: classify('provide_info'),
  })
  const result = await runner.runStep(ctx('179cm 70kg'))
  assert.equal(result.terminality, 'reply_and_wait')
  assert.ok(result.reply && result.reply.length > 0)
})

test('handoff: terminality handoff_and_wait, waiting_for_human, reason surfaced', async () => {
  const runner = createLoopRunner({
    llm: fakeLlm(),
    classify: classify('handoff'),
  })
  const result = await runner.runStep(ctx('我要投诉'))
  assert.equal(result.terminality, 'handoff_and_wait')
  assert.equal(result.nextStatus, 'waiting_for_human')
  const patch = result.memoryPatch as { handoffReason?: string; userQuestion?: string }
  assert.equal(patch.handoffReason, 'test')
  assert.equal(patch.userQuestion, '我要投诉')
})

test('ask_info with legacy adapter: delegates answer and carries extracted facts', async () => {
  const legacy = {
    async answer() {
      return {
        answer: '日租 199 元。',
        action: 'answer_faq',
        extractedFacts: { size: 'L' },
      }
    },
  }
  const runner = createLoopRunner({
    llm: fakeLlm(),
    legacy,
    classify: classify('ask_info'),
  })
  const result = await runner.runStep(ctx('多少钱'))
  assert.equal(result.reply, '日租 199 元。')
  assert.equal(result.nextStatus, 'waiting_for_user')
  assert.deepEqual(result.memoryPatch, { size: 'L' })
})

test('ask_info with handoff flagged by legacy: nextStatus waiting_for_human', async () => {
  const legacy = {
    async answer() {
      return { answer: '已为您转人工。', action: 'handoff', handoff: { reason: 'out_of_range' } }
    },
  }
  const runner = createLoopRunner({
    llm: fakeLlm(),
    legacy,
    classify: classify('ask_info'),
  })
  const result = await runner.runStep(ctx('退款'))
  assert.equal(result.nextStatus, 'waiting_for_human')
})

test('non-user_message event: conservative waiting_for_user result', async () => {
  const runner = createLoopRunner({
    llm: fakeLlm(),
    classify: classify('ask_info'),
  })
  const result = await runner.runStep({
    event: { ...userEvent(''), type: 'tool_result', payload: { ok: true } },
    memory: emptyMemory,
  })
  assert.equal(result.terminality, 'reply_and_wait')
  assert.equal(result.nextStatus, 'waiting_for_user')
})

test('ask_info without legacy: LLM fallback uses product tool', async () => {
  const { createDefaultToolRegistry } = await import('./tools/registry.js')
  const runner = createLoopRunner({
    llm: fakeLlm('fallback reply'),
    tools: createDefaultToolRegistry(),
    classify: classify('ask_info'),
  })
  const result = await runner.runStep(ctx('这款多少钱'))
  assert.equal(result.reply, 'fallback reply')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].toolName, 'get_product')
})

test('ask_info prefers agentsSdkRunner when provided (Phase 4 feature flag)', async () => {
  const sdkRunner = {
    async run() {
      return {
        sessionId: 'c:SUIT-001',
        traceId: 'e1',
        terminality: 'reply_and_wait' as const,
        reply: 'sdk 路径回答',
        toolCalls: [],
        nextStatus: 'waiting_for_user' as const,
      }
    },
  }
  const runner = createLoopRunner({
    llm: fakeLlm('should-not-be-used'),
    classify: classify('ask_info'),
    agentsSdkRunner: sdkRunner,
  })
  const result = await runner.runStep(ctx('这款怎么租'))
  assert.equal(result.reply, 'sdk 路径回答')
})

test('SDK lane is exposed only policy-allowed (low-risk) tools, never approval-gated ones', async () => {
  const { createDefaultToolRegistry } = await import('./tools/registry.js')
  let exposedNames: string[] = []
  const sdkRunner = {
    async run(input: Parameters<import('@rental/shared').AgentsSdkRunner['run']>[0]) {
      exposedNames = (input.tools ?? []).map((t) => t.name)
      return {
        sessionId: 'c:SUIT-001',
        traceId: 'e1',
        terminality: 'reply_and_wait' as const,
        reply: 'ok',
        toolCalls: [],
        nextStatus: 'waiting_for_user' as const,
      }
    },
  }
  const runner = createLoopRunner({
    llm: fakeLlm(),
    classify: classify('ask_info'),
    agentsSdkRunner: sdkRunner,
    tools: createDefaultToolRegistry(),
  })
  await runner.runStep(ctx('这款多少钱'))
  assert.ok(exposedNames.includes('get_product'), 'low-risk read tool should be exposed')
  assert.ok(!exposedNames.includes('issue_refund'), 'high-risk approval-gated tool must be withheld')
  assert.ok(!exposedNames.includes('create_handoff'), 'medium-risk tool must be withheld from auto-run')
})

test('agentsSdkRunner is skipped for non-ask_info actions', async () => {
  let sdkCalled = false
  const sdkRunner = {
    async run() {
      sdkCalled = true
      return {
        sessionId: 'c:SUIT-001',
        traceId: 'e1',
        terminality: 'reply_and_wait' as const,
        reply: '',
        toolCalls: [],
        nextStatus: 'waiting_for_user' as const,
      }
    },
  }
  const runner = createLoopRunner({
    llm: fakeLlm(),
    classify: classify('small_talk', '你好呀'),
    agentsSdkRunner: sdkRunner,
  })
  await runner.runStep(ctx('你好'))
  assert.equal(sdkCalled, false)
})

function fakeLlm(reply = '') {
  return {
    async complete() {
      return reply
    },
    async completeJson<T = unknown>(): Promise<T> {
      return {} as T
    },
  }
}
