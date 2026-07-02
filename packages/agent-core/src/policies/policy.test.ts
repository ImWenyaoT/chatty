import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultPolicy } from './policy.js'
import {
  createDefaultToolRegistry,
  ApprovalRequiredError,
  PolicyDenyError,
} from '../tools/registry.js'
import type { RuntimeToolCall } from '@rental/shared'

const policy = createDefaultPolicy()

/**
 * Builds a RuntimeToolCall descriptor for policy assertions.
 */
function call(
  name: string,
  risk: 'low' | 'medium' | 'high',
  approvalRequired = false,
): RuntimeToolCall {
  return { toolName: name, arguments: {}, risk, approvalRequired }
}

test('low risk tool => allow', () => {
  const d = policy.check(call('add_internal_note', 'low'), { sessionStatus: 'active' })
  assert.deepEqual(d, { action: 'allow' })
})

test('medium risk tool => require_approval', () => {
  const d = policy.check(call('create_handoff', 'medium'), { sessionStatus: 'active' })
  assert.equal(d.action, 'require_approval')
})

test('high risk tool => require_approval', () => {
  const d = policy.check(call('issue_refund', 'high', true), { sessionStatus: 'active' })
  assert.equal(d.action, 'require_approval')
})

test('closed session => deny regardless of risk', () => {
  const d = policy.check(call('add_internal_note', 'low'), { sessionStatus: 'closed' })
  assert.equal(d.action, 'deny')
})

test('invokeWithPolicy allows low-risk tool to execute', async () => {
  const out = await createDefaultToolRegistry().invokeWithPolicy(
    'add_internal_note',
    { conversationId: 'c:SUIT-001', note: 'x' },
    policy,
    { sessionStatus: 'active' },
  )
  assert.equal((out as { ok: boolean }).ok, true)
})

test('invokeWithPolicy throws ApprovalRequiredError for medium-risk tool', async () => {
  await assert.rejects(
    () =>
      createDefaultToolRegistry().invokeWithPolicy(
        'create_handoff',
        { conversationId: 'c:SUIT-001', reason: 'x' },
        policy,
        { sessionStatus: 'active' },
      ),
    (err: unknown) => err instanceof ApprovalRequiredError,
  )
})

test('invokeWithPolicy throws PolicyDenyError on closed session', async () => {
  await assert.rejects(
    () =>
      createDefaultToolRegistry().invokeWithPolicy(
        'add_internal_note',
        { conversationId: 'c:SUIT-001', note: 'x' },
        policy,
        { sessionStatus: 'closed' },
      ),
    (err: unknown) => err instanceof PolicyDenyError,
  )
})
