import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlaybook, loadPlaybooks } from './loader.js'
import { SIZE_CONSULTATION_PLAYBOOK } from './playbook.js'

test('SIZE_CONSULTATION_PLAYBOOK is itself a valid Playbook', () => {
  const p = loadPlaybook(SIZE_CONSULTATION_PLAYBOOK)
  assert.equal(p.id, 'size-consultation')
  assert.ok(p.steps.length >= 2)
})

test('loadPlaybook accepts a well-formed object', () => {
  const p = loadPlaybook({
    id: 'refund-escalation',
    name: '退款升级',
    trigger: '用户要求退款',
    description: '转人工并记录上下文',
    steps: [{ description: '转人工', tool: 'create_handoff' }],
  })
  assert.equal(p.id, 'refund-escalation')
})

test('loadPlaybook rejects an object missing required fields', () => {
  assert.throws(() =>
    loadPlaybook({ id: 'x', name: 'x' }), // missing trigger/description/steps
  )
})

test('loadPlaybook rejects empty steps array', () => {
  assert.throws(() =>
    loadPlaybook({
      id: 'x',
      name: 'x',
      trigger: 't',
      description: 'd',
      steps: [],
    }),
  )
})

test('loadPlaybooks keeps valid items and drops invalid ones', () => {
  const list = [
    SIZE_CONSULTATION_PLAYBOOK,
    { id: 'bad', name: 'bad' }, // invalid
  ]
  const valid = loadPlaybooks(list)
  assert.equal(valid.length, 1)
  assert.equal(valid[0].id, 'size-consultation')
})
