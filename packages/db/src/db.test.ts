import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './database.js'
import {
  createMemoryRepository,
  createSessionRepository,
  createTraceRepository,
} from './index.js'

function freshDb() {
  return openDatabase(':memory:')
}

test('session repository: create, get, update', () => {
  const db = freshDb()
  const sessions = createSessionRepository(db)

  const created = sessions.create({
    id: 'sess-1',
    customerId: 'c1',
    conversationId: 'c1:SUIT-001',
    productId: 'SUIT-001',
  })
  assert.equal(created.status, 'active')
  assert.equal(created.currentStep, 'init')

  const found = sessions.get('sess-1')
  assert.ok(found)
  assert.equal(found!.customerId, 'c1')

  const byConv = sessions.findByConversation('c1:SUIT-001')
  assert.ok(byConv)

  const updated = sessions.update('sess-1', { status: 'waiting_for_user', currentStep: 'review' })
  assert.equal(updated?.status, 'waiting_for_user')
  assert.equal(updated?.currentStep, 'review')

  assert.equal(sessions.get('nope'), undefined)
})

test('trace repository: append then query oldest-first', () => {
  const db = freshDb()
  const sessions = createSessionRepository(db)
  const traces = createTraceRepository(db)
  sessions.create({ id: 'sess-2', customerId: 'c2', conversationId: 'c2:SUIT-001' })

  traces.append({
    id: 'tr-1',
    sessionId: 'sess-2',
    eventType: 'user_message',
    input: { question: '多少钱' },
  })
  traces.append({
    id: 'tr-2',
    sessionId: 'sess-2',
    eventType: 'agent_reply_sent',
    intent: 'ask_price',
    action: 'answer_faq',
    input: { question: '多少钱' },
    output: { reply: '199/天' },
    toolCalls: [],
    references: [{ text: 'price rule' }],
  })

  const list = traces.queryBySession('sess-2')
  assert.equal(list.length, 2)
  // oldest-first
  assert.equal(list[0].id, 'tr-1')
  assert.equal(list[1].action, 'answer_faq')
  assert.deepEqual(list[1].references, [{ text: 'price rule' }])
})

test('memory repository: upsert + snapshot round-trip', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)

  memory.upsertCustomer('c3', { globalSummary: '老客户' })
  memory.upsertProduct(
    { conversationId: 'c3:SUIT-001', customerId: 'c3', productId: 'SUIT-001' },
    { summary: '当前会话', recentMessages: [{ role: 'user', content: 'hi' }] },
  )

  const snap = memory.snapshot({
    customerId: 'c3',
    conversationId: 'c3:SUIT-001',
    productId: 'SUIT-001',
  })
  assert.deepEqual(snap.recentMessages, [{ role: 'user', content: 'hi' }])
  assert.equal((snap.customerMemory as { globalSummary: string }).globalSummary, '老客户')
})

test('memory repository: JSON fallback reads legacy memory-store.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatty-fallback-'))
  const legacyPath = join(dir, 'memory-store.json')
  writeFileSync(
    legacyPath,
    JSON.stringify({
      'c4': {
        customerId: 'c4',
        globalSummary: 'legacy summary',
        sessionContext: { handoffNeeded: null },
        bodyProfiles: [{ profileId: 'default', heightCm: 175 }],
        productMemories: {
          'c4:SUIT-001': {
            productId: 'SUIT-001',
            conversationId: 'c4:SUIT-001',
            summary: 'legacy product',
            recentMessages: [{ role: 'user', content: 'legacy q' }],
            conversationProfile: { stage: 'body_collecting' },
            reviews: [],
          },
        },
      },
    }),
  )

  const db = freshDb()
  const memory = createMemoryRepository(db, { legacyMemoryPath: legacyPath })

  const snap = memory.snapshot({
    customerId: 'c4',
    conversationId: 'c4:SUIT-001',
    productId: 'SUIT-001',
  })
  assert.equal((snap.customerMemory as { globalSummary: string }).globalSummary, 'legacy summary')
  assert.deepEqual(snap.recentMessages, [{ role: 'user', content: 'legacy q' }])
})

test('memory repository: empty snapshot when nothing is known', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db) // no legacy path
  const snap = memory.snapshot({ customerId: 'ghost', conversationId: 'ghost:SUIT-001' })
  assert.equal(snap.customerMemory, undefined)
  assert.deepEqual(snap.recentMessages, [])
})
