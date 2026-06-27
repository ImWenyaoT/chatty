import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentStepResult, AgentsSdkRunInput, ConversationEvent, RuntimeTool } from '@rental/shared'
import {
  createAgentsSdkRunnerFromFunction,
  readQuestion,
  sdkToolExecute,
  toStepResult,
} from './agents-sdk-adapter.js'

function userEvent(question: string): ConversationEvent {
  return {
    eventId: 'e1',
    type: 'user_message',
    customerId: 'c',
    conversationId: 'c:SUIT-001',
    productId: 'SUIT-001',
    source: 'customer',
    payload: { question },
    occurredAt: '2026-06-26T00:00:00.000Z',
    traceId: 'tr1',
  }
}

function baseInput(question: string): AgentsSdkRunInput {
  return { event: userEvent(question), instructions: 'you are chatty', context: {} }
}

test('injected runner delegates run and returns the AgentStepResult unchanged', async () => {
  const expected: AgentStepResult = {
    sessionId: 'c:SUIT-001',
    traceId: 'tr1',
    terminality: 'reply_and_wait',
    reply: '日租 199 元。',
    toolCalls: [],
    nextStatus: 'waiting_for_user',
  }
  const runner = createAgentsSdkRunnerFromFunction(async () => expected)
  const result = await runner.run(baseInput('多少钱'))
  assert.deepEqual(result, expected)
})

test('injected runner receives the full AgentsSdkRunInput', async () => {
  let captured: AgentsSdkRunInput | undefined
  const runner = createAgentsSdkRunnerFromFunction(async (input) => {
    captured = input
    return {
      sessionId: input.event.conversationId,
      traceId: input.event.traceId ?? input.event.eventId,
      terminality: 'reply_and_wait',
      reply: 'ok',
      toolCalls: [],
      nextStatus: 'waiting_for_user',
    }
  })
  await runner.run(baseInput('在吗'))
  assert.ok(captured, 'runner should have captured the input')
  const payload = captured.event.payload as { question?: string }
  assert.equal(payload.question, '在吗')
  assert.equal(captured.instructions, 'you are chatty')
})

test('injected runner can surface handoff terminality', async () => {
  const runner = createAgentsSdkRunnerFromFunction(async (input) => ({
    sessionId: input.event.conversationId,
    traceId: input.event.traceId ?? input.event.eventId,
    terminality: 'handoff_and_wait' as const,
    reply: '已转人工',
    toolCalls: [],
    nextStatus: 'waiting_for_human' as const,
  }))
  const result = await runner.run(baseInput('我要投诉'))
  assert.equal(result.terminality, 'handoff_and_wait')
  assert.equal(result.nextStatus, 'waiting_for_human')
})

// --- pure-function coverage of the real SDK lane mapping (grill #1) --------
// These exercise readQuestion()/toStepResult() without a real OpenAI call,
// covering the mapping logic of createAgentsSdkRunner that the injection tests
// above bypass.

test('readQuestion pulls the question string out of a payload object', () => {
  assert.equal(readQuestion(baseInput('多少钱')), '多少钱')
})

test('readQuestion handles a plain-string payload', () => {
  const input: AgentsSdkRunInput = {
    event: { ...userEvent(''), payload: '直接字符串问题' },
    instructions: '',
    context: {},
  }
  assert.equal(readQuestion(input), '直接字符串问题')
})

test('readQuestion returns empty string when payload has no question', () => {
  const input: AgentsSdkRunInput = {
    event: { ...userEvent(''), payload: { other: 'x' } },
    instructions: '',
    context: {},
  }
  assert.equal(readQuestion(input), '')
})

test('toStepResult maps a normal reply to reply_and_wait', () => {
  const r = toStepResult(baseInput('在吗'), '在的，请问有什么可以帮您？', false)
  assert.equal(r.terminality, 'reply_and_wait')
  assert.equal(r.nextStatus, 'waiting_for_user')
  assert.equal(r.reply, '在的，请问有什么可以帮您？')
  assert.equal(r.sessionId, 'c:SUIT-001')
  assert.equal(r.traceId, 'tr1')
})

test('toStepResult maps a handoff to handoff_and_wait', () => {
  const r = toStepResult(baseInput('转人工'), '好的，帮您转接', true)
  assert.equal(r.terminality, 'handoff_and_wait')
  assert.equal(r.nextStatus, 'waiting_for_human')
})

test('toStepResult falls back to a canned handoff reply when output is empty', () => {
  const r = toStepResult(baseInput('投诉'), '', true)
  assert.equal(r.terminality, 'handoff_and_wait')
  assert.ok((r.reply ?? '').length > 0, 'should fall back to a canned handoff message')
})

test('toStepResult carries an empty reply when non-handoff output is empty', () => {
  const r = toStepResult(baseInput('hi'), '', false)
  assert.equal(r.terminality, 'reply_and_wait')
  assert.equal(r.reply, '')
})

// --- defense-in-depth: the SDK tool executor never auto-runs an approval-gated
// tool, even if one is handed to createAgentsSdkRunner directly (bypassing the
// loop-runner's policy filter). ---------------------------------------------

test('sdkToolExecute refuses an approvalRequired tool without calling execute', async () => {
  let executed = false
  const refundTool: RuntimeTool = {
    name: 'issue_refund',
    description: 'refund',
    risk: 'high',
    approvalRequired: true,
    async execute() {
      executed = true
      return { ok: true }
    },
  }
  const out = (await sdkToolExecute(refundTool)({ orderNo: 'A1', amount: 100 })) as unknown as {
    refused?: boolean
  }
  assert.equal(executed, false, 'must not execute an approval-gated tool')
  assert.equal(out.refused, true, 'should return a structured refusal')
})

test('sdkToolExecute runs a low-risk tool normally', async () => {
  const productTool: RuntimeTool = {
    name: 'get_product',
    description: 'product',
    risk: 'low',
    approvalRequired: false,
    async execute(args) {
      return { found: true, echo: args }
    },
  }
  const out = (await sdkToolExecute(productTool)({ productId: 'SUIT-001' })) as unknown as {
    found?: boolean
  }
  assert.equal(out.found, true)
})
