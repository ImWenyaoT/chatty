import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry, ApprovalRequiredError, ToolNotFoundError } from './registry.js'

// MVP tool set: the 3 actions the harness scheduler dispatches + get_product
// catalog lookup + the schema-only high-risk refund stub.
const EXPECTED_TOOLS = [
  'get_product',
  'check_availability',
  'create_handoff',
  'schedule_followup',
  'issue_refund',
]

function registry() {
  return createDefaultToolRegistry()
}

test('default registry registers exactly the 5 MVP tools', () => {
  const names = registry()
    .list()
    .map((t) => t.name)
    .sort()
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort())
})

test('get_product returns the seeded catalog entry', async () => {
  const out = await registry().invoke('get_product', { productId: 'suit-001' })
  const r = out as { found: boolean; id: string; dailyPrice: number }
  assert.equal(r.found, true)
  assert.equal(r.id, 'SUIT-001')
  assert.equal(r.dailyPrice, 199)
})

test('check_availability answers for a known product', async () => {
  const out = await registry().invoke('check_availability', { productId: 'SUIT-001', size: 'L' })
  const r = out as { available: boolean; productId: string }
  assert.equal(r.available, true)
  assert.equal(r.productId, 'SUIT-001')
})

test('create_handoff is medium risk but runs without hard approval gate', async () => {
  const out = await registry().invoke('create_handoff', {
    conversationId: 'c:SUIT-001',
    reason: '投诉',
    context: { x: 1 },
  })
  const r = out as { ok: boolean; handoffId: string }
  assert.equal(r.ok, true)
  assert.equal(r.handoffId, 'HO-c:SUIT-001')
})

test('schedule_followup echoes a deterministic receipt', async () => {
  const out = await registry().invoke('schedule_followup', {
    conversationId: 'c:SUIT-001',
    dueAt: '2026-06-27T00:00:00.000Z',
    reason: '物流跟进',
  })
  assert.equal((out as { followupId: string }).followupId, 'FU-c:SUIT-001')
})

test('schedule_followup observes cancellation while its capability is running', async () => {
  const controller = new AbortController()
  let capabilitySignal!: AbortSignal
  const tools = createDefaultToolRegistry(undefined, {
    scheduleFollowup: async (_input, options) => {
      assert.ok(options?.signal)
      capabilitySignal = options.signal
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        }),
      )
      return { ok: true }
    },
  })
  const execution = tools.invoke(
    'schedule_followup',
    { conversationId: 'cancel-tool', dueAt: '2026-07-12T00:00:00.000Z', reason: 'test' },
    { signal: controller.signal },
  )
  while (!capabilitySignal) await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort(new Error('workflow cancelled'))
  await assert.rejects(execution, /workflow cancelled/)
  assert.equal(capabilitySignal, controller.signal)
})

test('issue_refund is high risk + approvalRequired => invoke throws ApprovalRequiredError', async () => {
  await assert.rejects(
    () => registry().invoke('issue_refund', { orderNo: 'ORD-1001', amount: 100, reason: '破损' }),
    (err: unknown) => err instanceof ApprovalRequiredError,
  )
})

test('invoke on unknown tool throws ToolNotFoundError', async () => {
  await assert.rejects(
    () => registry().invoke('does_not_exist', {}),
    (err: unknown) => err instanceof ToolNotFoundError,
  )
})

test('issue_refund risk is high and approvalRequired is true', () => {
  const t = registry().get('issue_refund')
  assert.equal(t?.risk, 'high')
  assert.equal(t?.approvalRequired, true)
})
