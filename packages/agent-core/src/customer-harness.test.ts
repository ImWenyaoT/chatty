import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationEvent, MemorySnapshot } from '@rental/shared'
import {
  buildCustomerServiceContext,
  createDefaultToolRegistry,
  createCustomerServiceModelOutput,
  executeCustomerServiceAction,
  parseCustomerServiceOutput,
  runCustomerServiceHarnessStep,
  scheduleCustomerServiceTask,
} from './index.js'

function userEvent(question: string): ConversationEvent {
  return {
    eventId: 'evt_1',
    type: 'user_message',
    customerId: 'c',
    conversationId: 'c:SUIT-001',
    productId: 'SUIT-001',
    source: 'customer',
    payload: { question },
    occurredAt: '2026-07-03T00:00:00.000Z',
    traceId: 'tr_1',
  }
}

function memory(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    customerId: 'c',
    conversationId: 'c:SUIT-001',
    productId: 'SUIT-001',
    recentMessages: [],
    ...overrides,
  }
}

test('scheduler maps size-and-date slot collection to check_availability when required context is present', () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent('5月10到5月12，身高 179 体重 70kg，有 L 吗'),
    memory: memory(),
  })

  assert.equal(task.kind, 'check_availability')
  assert.equal(task.terminality, 'tool_then_continue')
  assert.deepEqual(task.requiredContext, ['productId', 'rentalPeriod', 'bodyMeasurements'])
})

test('scheduler routes complaints and refunds to handoff instead of auto reply', () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent('我要投诉，给我退款'),
    memory: memory(),
  })

  assert.equal(task.kind, 'handoff')
  assert.equal(task.terminality, 'handoff_and_wait')
  assert.equal(task.risk, 'medium')
})

test('context builder keeps ordered fragments for prompt assembly and inspection', () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent('这款多少钱'),
    memory: memory({ recentMessages: [{ role: 'assistant', content: '上一轮回复' }] }),
  })
  const context = buildCustomerServiceContext({
    event: userEvent('这款多少钱'),
    memory: memory({ recentMessages: [{ role: 'assistant', content: '上一轮回复' }] }),
    task,
  })

  assert.deepEqual(
    context.fragments.map((fragment) => fragment.kind),
    ['task', 'user_message', 'memory', 'product'],
  )
  assert.ok(context.prompt.includes('当前客服任务'))
  assert.ok(context.prompt.includes('SUIT-001'))
})

test('output parser accepts strict JSON actions and falls back to answer_question on invalid output', () => {
  const parsed = parseCustomerServiceOutput(
    '{"action":"check_availability","reply":"我先帮您查库存","toolName":"check_availability","toolArgs":{"productId":"SUIT-001","size":"L"}}',
  )
  assert.equal(parsed.action, 'check_availability')
  assert.equal(parsed.toolName, 'check_availability')

  const fallback = parseCustomerServiceOutput('不是 JSON')
  assert.equal(fallback.action, 'answer_question')
  assert.equal(fallback.reply, '我先帮您确认一下，再继续处理。')
})

test('model output composer turns scheduled tasks into constrained customer-service actions', () => {
  const event = userEvent('这款有 L 吗，5月10到12号穿')
  const task = scheduleCustomerServiceTask({ event, memory: memory() })
  const parsed = parseCustomerServiceOutput(
    createCustomerServiceModelOutput({
      event,
      memory: memory(),
      task,
    }),
  )

  assert.equal(parsed.action, 'check_availability')
  assert.equal(parsed.toolName, 'check_availability')
  assert.deepEqual(parsed.toolArgs, { productId: 'SUIT-001', size: 'L' })
})

test('executor runs low-risk availability checks through the tool registry', async () => {
  const result = await executeCustomerServiceAction({
    action: {
      action: 'check_availability',
      reply: '我先帮您查一下。',
      toolName: 'check_availability',
      toolArgs: { productId: 'SUIT-001', size: 'L' },
    },
    registry: createDefaultToolRegistry(),
    sessionStatus: 'active',
  })

  assert.equal(result.terminality, 'tool_then_continue')
  assert.equal(result.nextStatus, 'waiting_for_user')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].toolName, 'check_availability')
})

test('harness step returns a bounded trace with task, context, action and memory patch', async () => {
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款有 L 吗，5月10到12号穿'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelOutput:
      '{"action":"check_availability","reply":"我先帮您查一下 L 码档期。","toolName":"check_availability","toolArgs":{"productId":"SUIT-001","size":"L"}}',
  })

  assert.equal(result.step.terminality, 'tool_then_continue')
  assert.equal(result.trace.task.kind, 'check_availability')
  assert.equal(result.trace.action.action, 'check_availability')
  assert.equal(result.trace.toolCalls.length, 1)
  assert.deepEqual(result.step.memoryPatch, {
    lastHarnessTask: 'check_availability',
    lastHarnessAction: 'check_availability',
  })
})
