import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentStepResult, AgentsSdkRunInput, ConversationEvent } from '@rental/shared'
import { createAgentsSdkRunnerFromFunction } from './agents-sdk-adapter.js'

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
