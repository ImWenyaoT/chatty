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
  createTraceReviewRepository,
  createFailureCaseRepository,
} from './index.js'

function freshDb() {
  return openDatabase(':memory:')
}

test('openDatabase creates missing parent directories for a file-backed path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatty-dbdir-'))
  // The nested data/ directory does not exist yet — openDatabase must create it
  // rather than letting better-sqlite3 throw "unable to open database file".
  const nested = join(dir, 'data', 'nested', 'chatty.db')
  const db = openDatabase(nested)
  const sessions = createSessionRepository(db)
  const created = sessions.create({ id: 'x', customerId: 'c', conversationId: 'c:p' })
  assert.equal(created.status, 'active')
  db.close()
})

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

test('trace repository: append returns the inserted row directly (no re-query dependency)', () => {
  const db = freshDb()
  const sessions = createSessionRepository(db)
  const traces = createTraceRepository(db)
  sessions.create({ id: 'sess-append', customerId: 'c', conversationId: 'c:p' })

  // Even past a large batch, append must return THIS row fully populated — the
  // old implementation re-queried the newest 100 and could miss the row on a
  // created_at tie, returning undefined behind a `!` assertion.
  let last: ReturnType<typeof traces.append> | undefined
  for (let i = 0; i < 150; i++) {
    last = traces.append({
      id: `tr-${i}`,
      sessionId: 'sess-append',
      eventType: 'agent_reply_sent',
      action: 'reply_and_wait',
      input: { question: `q${i}` },
      output: { reply: `r${i}` },
    })
  }
  assert.ok(last, 'append must return the inserted trace')
  assert.equal(last!.id, 'tr-149')
  assert.equal(last!.sessionId, 'sess-append')
  assert.deepEqual(last!.input, { question: 'q149' })
  assert.deepEqual(last!.output, { reply: 'r149' })
  assert.equal(last!.toolCalls.length, 0)
  assert.ok(last!.createdAt.length > 0, 'createdAt should be populated')
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

test('memory repository: appendRecentMessages accumulates turns and snapshot reads them back', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)
  const key = { customerId: 'c9', productId: 'SUIT-001', conversationId: 'c9:SUIT-001' }

  memory.appendRecentMessages(key, [
    { role: 'user', content: '多少钱' },
    { role: 'assistant', content: '日租 199 元' },
  ])
  let snap = memory.snapshot({
    customerId: 'c9',
    productId: 'SUIT-001',
    conversationId: 'c9:SUIT-001',
  })
  assert.equal(snap.recentMessages.length, 2)

  // A second turn appends rather than replacing — this is the continuity the
  // route needs so the next snapshot sees prior messages.
  memory.appendRecentMessages(key, [{ role: 'user', content: '尺码有 L 吗' }])
  snap = memory.snapshot({ customerId: 'c9', productId: 'SUIT-001', conversationId: 'c9:SUIT-001' })
  assert.equal(snap.recentMessages.length, 3)
  assert.equal((snap.recentMessages[2] as { content: string }).content, '尺码有 L 吗')
})

test('memory repository: appendRecentMessages caps to the most recent N', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)
  const key = { customerId: 'c10', productId: 'p', conversationId: 'c10:p' }

  for (let i = 0; i < 25; i++) {
    memory.appendRecentMessages(key, [{ role: 'user', content: `m${i}` }], 20)
  }
  const snap = memory.snapshot({ customerId: 'c10', productId: 'p', conversationId: 'c10:p' })
  assert.equal(snap.recentMessages.length, 20, 'should keep only the most recent 20')
  const last = snap.recentMessages[snap.recentMessages.length - 1] as { content: string }
  assert.equal(last.content, 'm24', 'newest message retained')
  const first = snap.recentMessages[0] as { content: string }
  assert.equal(first.content, 'm5', 'oldest beyond the cap dropped')
})

test('memory repository: JSON fallback reads legacy memory-store.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatty-fallback-'))
  const legacyPath = join(dir, 'memory-store.json')
  writeFileSync(
    legacyPath,
    JSON.stringify({
      c4: {
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

test('trace review repository: append then findByTrace round-trip', () => {
  const db = freshDb()
  const sessions = createSessionRepository(db)
  const traces = createTraceRepository(db)
  const reviews = createTraceReviewRepository(db)
  sessions.create({ id: 'sess-r', customerId: 'cr', conversationId: 'cr:SUIT-001' })
  traces.append({ id: 'tr-r', sessionId: 'sess-r', eventType: 'agent_reply_sent', input: {} })

  const review = reviews.append({
    id: 'rev-1',
    traceId: 'tr-r',
    score: 4,
    issues: ['未回答价格', '语气生硬'],
    suggestions: ['给出具体日租价'],
    suggestedReply: '这件日租 199 元哦~',
    evaluatorModel: 'gpt-4o-mini',
    promptVersion: 'v1',
  })

  assert.equal(review.score, 4)
  assert.deepEqual(review.issues, ['未回答价格', '语气生硬'])
  assert.equal(review.suggestedReply, '这件日租 199 元哦~')

  const byTrace = reviews.findByTrace('tr-r')
  assert.equal(byTrace.length, 1)
  assert.equal(byTrace[0].id, 'rev-1')
})

test('trace repository: findUnevaluated excludes reviewed traces', () => {
  const db = freshDb()
  const sessions = createSessionRepository(db)
  const traces = createTraceRepository(db)
  const reviews = createTraceReviewRepository(db)
  sessions.create({ id: 'sess-u', customerId: 'cu', conversationId: 'cu:SUIT-001' })
  traces.append({ id: 'tr-reviewed', sessionId: 'sess-u', eventType: 'user_message', input: {} })
  traces.append({ id: 'tr-fresh', sessionId: 'sess-u', eventType: 'agent_reply_sent', input: {} })
  reviews.append({ id: 'rev-2', traceId: 'tr-reviewed', score: 7, issues: [] })

  const unevaluated = traces.findUnevaluated()
  assert.equal(unevaluated.length, 1)
  assert.equal(unevaluated[0].id, 'tr-fresh')
})

test('failure case repository: create, findOpen, markPromoted', () => {
  const db = freshDb()
  const sessions = createSessionRepository(db)
  const traces = createTraceRepository(db)
  const failures = createFailureCaseRepository(db)
  sessions.create({ id: 'sess-f', customerId: 'cf', conversationId: 'cf:SUIT-001' })
  traces.append({
    id: 'tr-f',
    sessionId: 'sess-f',
    eventType: 'agent_reply_sent',
    input: { question: '多少钱' },
    output: { reply: '不知道' },
  })

  const fc = failures.create({
    id: 'fc-1',
    traceId: 'tr-f',
    sessionId: 'sess-f',
    score: 3,
    issues: ['拒绝回答', '态度差'],
    input: { question: '多少钱' },
    output: { reply: '不知道' },
  })
  assert.equal(fc.status, 'open')
  assert.deepEqual(fc.issues, ['拒绝回答', '态度差'])

  const open = failures.findOpen()
  assert.equal(open.length, 1)
  assert.equal(open[0].id, 'fc-1')

  failures.markPromoted('fc-1')
  assert.equal(failures.findOpen().length, 0)
})

test('failure case repository: markDismissed exits the open queue', () => {
  const db = freshDb()
  const sessions = createSessionRepository(db)
  const traces = createTraceRepository(db)
  const failures = createFailureCaseRepository(db)
  sessions.create({ id: 'sess-d', customerId: 'cd', conversationId: 'cd:SUIT-001' })
  traces.append({ id: 'tr-d', sessionId: 'sess-d', eventType: 'agent_reply_sent', input: {} })
  failures.create({
    id: 'fc-d',
    traceId: 'tr-d',
    sessionId: 'sess-d',
    score: 2,
    issues: ['x'],
    input: {},
  })
  assert.equal(failures.findOpen().length, 1)
  failures.markDismissed('fc-d')
  // dismissed is a terminal exit: not in the open queue anymore
  assert.equal(failures.findOpen().length, 0)
})

test('foreign keys: inserting a review for a non-existent trace is rejected', () => {
  const db = freshDb()
  const reviews = createTraceReviewRepository(db)
  // PRAGMA foreign_keys=ON is set by openDatabase(); a trace_review whose
  // trace_id has no matching agent_traces row must be rejected (grill #4).
  assert.throws(() =>
    reviews.append({
      id: 'rev-orphan',
      traceId: 'does-not-exist',
      score: 5,
      issues: [],
    }),
  )
})

test('foreign keys: failure_case requires a real trace AND session', () => {
  const db = freshDb()
  const failures = createFailureCaseRepository(db)
  assert.throws(() =>
    failures.create({
      id: 'fc-orphan',
      traceId: 'ghost-trace',
      sessionId: 'ghost-session',
      score: 3,
      issues: [],
      input: {},
    }),
  )
})
