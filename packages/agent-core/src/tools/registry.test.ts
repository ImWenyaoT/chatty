import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDefaultToolRegistry,
  ApprovalRequiredError,
  ToolNotFoundError,
} from './registry.js'

// PRD §11 MVP tool set. The 3 original stubs + 7 new tools + 1 high-risk stub.
const EXPECTED_TOOLS = [
  'get_product',
  'check_availability',
  'get_media',
  'search_products',
  'calculate_price',
  'get_order_history',
  'get_order_status',
  'create_handoff',
  'schedule_followup',
  'add_internal_note',
  'issue_refund',
]

function registry() {
  return createDefaultToolRegistry()
}

test('default registry registers all 11 PRD tools', () => {
  const names = registry().list().map((t) => t.name).sort()
  for (const expected of EXPECTED_TOOLS) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`)
  }
})

test('search_products returns matches for a known keyword', async () => {
  const out = await registry().invoke('search_products', { query: '西装' })
  const r = out as { matches: { id: string }[] }
  assert.deepEqual(r.matches.map((m) => m.id), ['SUIT-001'])
})

test('calculate_price quotes day1 full + renewals half', async () => {
  const out = await registry().invoke('calculate_price', {
    productId: 'SUIT-001',
    rentalPeriod: 3,
    quantity: 2,
  })
  const r = out as { total: number; perUnit: number }
  // 199 + 2*99.5 = 398 per unit ; *2 = 796
  assert.equal(r.perUnit, 398)
  assert.equal(r.total, 796)
})

test('get_order_history returns customer orders', async () => {
  const out = await registry().invoke('get_order_history', { customerId: 'c' })
  const r = out as { found: boolean; orders: { orderNo: string }[] }
  assert.equal(r.found, true)
  assert.deepEqual(r.orders.map((o) => o.orderNo), ['ORD-1001'])
})

test('get_order_status returns a single order', async () => {
  const out = await registry().invoke('get_order_status', { orderNo: 'ord-1001' })
  const r = out as { found: boolean; orderNo: string; status: string }
  assert.equal(r.found, true)
  assert.equal(r.orderNo, 'ORD-1001')
  assert.equal(r.status, 'shipped')
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

test('add_internal_note echoes a deterministic receipt', async () => {
  const out = await registry().invoke('add_internal_note', {
    conversationId: 'c:SUIT-001',
    note: '客户为高价值用户',
  })
  assert.equal((out as { noteId: string }).noteId, 'NOTE-c:SUIT-001')
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
