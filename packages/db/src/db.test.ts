import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from '@rental/shared'
import { openDatabase } from './database.js'
import {
  createMemoryRepository,
  createSessionRepository,
  createTraceRepository,
  createTraceReviewRepository,
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

test('trace review repository: upsert review and summarize product feedback labels', () => {
  const db = freshDb()
  const sessions = createSessionRepository(db)
  const traces = createTraceRepository(db)
  const reviews = createTraceReviewRepository(db)
  sessions.create({ id: 'sess-review', customerId: 'c', conversationId: 'c:p' })
  traces.append({
    id: 'tr-review-1',
    sessionId: 'sess-review',
    eventType: 'agent_reply_sent',
    action: 'answer_question',
    input: { question: '押金多少' },
    output: { reply: '押金需要确认' },
  })
  traces.append({
    id: 'tr-review-2',
    sessionId: 'sess-review',
    eventType: 'agent_reply_sent',
    action: 'handoff',
    input: { question: '我要投诉' },
    output: { reply: '转人工' },
  })

  reviews.upsert({
    traceId: 'tr-review-1',
    label: 'fail',
    reviewer: 'pm',
    note: '没有回答押金规则',
    tags: ['missing_policy', 'needs_golden'],
  })
  reviews.upsert({
    traceId: 'tr-review-1',
    label: 'flagged',
    reviewer: 'pm',
    note: '可接受但应补金标',
    tags: ['needs_golden'],
  })
  reviews.upsert({
    traceId: 'tr-review-2',
    label: 'pass',
    reviewer: 'pm',
    tags: ['handoff_ok'],
  })

  const list = reviews.listBySession('sess-review')
  assert.equal(list.length, 2)
  assert.equal(list[0].traceId, 'tr-review-1')
  assert.equal(list[0].label, 'flagged')
  assert.deepEqual(list[0].tags, ['needs_golden'])
  assert.equal(list[1].label, 'pass')

  assert.deepEqual(reviews.summarize(), {
    total: 2,
    pass: 1,
    fail: 0,
    flagged: 1,
    tags: { handoff_ok: 1, needs_golden: 1 },
  })
})

test('trace review repository: accepts external trace ids for route-bundle feedback', () => {
  const db = freshDb()
  const reviews = createTraceReviewRepository(db)

  const review = reviews.upsert({
    traceId: 'tr-external',
    label: 'fail',
    reviewer: 'pm',
    tags: ['missing_trace_context'],
  })

  assert.equal(review.traceId, 'tr-external')
  assert.deepEqual(reviews.summarize(), {
    total: 1,
    pass: 0,
    fail: 1,
    flagged: 0,
    tags: { missing_trace_context: 1 },
  })
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

// 一无所知时 snapshot 仍要给出完整形状的缺省值，调用方无需判空四个新字段。
test('memory repository: empty snapshot still carries complete default memory fields', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)
  const snap = memory.snapshot({ customerId: 'ghost2', conversationId: 'ghost2:SUIT-001' })
  assert.deepEqual(snap.conversationProfile, {})
  assert.deepEqual(snap.bodyProfiles, [])
  assert.equal(snap.summary, '')
  assert.equal(snap.globalSummary, '')
})

// commitTurn 首次调用：一个事务里同时创建 customer_memories 与 product_memories，
// snapshot 能读回完整会话记忆（消息 + profile + 摘要）。
test('memory repository: commitTurn creates both rows on first call and snapshot reads them back', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)
  const key = { customerId: 'c20', productId: 'SUIT-001', conversationId: 'c20:SUIT-001' }

  memory.commitTurn(key, {
    appendMessages: [
      { role: 'user', content: '5月10号到12号租黑西装' },
      { role: 'assistant', content: '好的，帮您记下档期' },
    ],
    conversationProfile: {
      heightCm: 178,
      rentalPeriod: { startDate: '2026-5-10', endDate: '2026-5-12' },
    },
    bodyProfiles: [{ profileId: 'default', heightCm: 178, weightKg: 70 }],
    summary: '确认档期中',
    globalSummary: '新客户，首次咨询',
  })

  const snap = memory.snapshot(key)
  assert.equal(snap.recentMessages.length, 2)
  assert.deepEqual(snap.conversationProfile, {
    heightCm: 178,
    rentalPeriod: { startDate: '2026-5-10', endDate: '2026-5-12' },
  })
  assert.deepEqual(snap.bodyProfiles, [{ profileId: 'default', heightCm: 178, weightKg: 70 }])
  assert.equal(snap.summary, '确认档期中')
  assert.equal(snap.globalSummary, '新客户，首次咨询')
})

// commitTurn 二次调用：只带部分字段时是合并（upsert）而非整行覆盖——
// 未提供的字段必须保持首次写入的值。
test('memory repository: commitTurn second call merges — untouched fields survive', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)
  const key = { customerId: 'c21', productId: 'SUIT-002', conversationId: 'c21:SUIT-002' }

  memory.commitTurn(key, {
    appendMessages: [{ role: 'user', content: '第一轮' }],
    conversationProfile: { heightCm: 170 },
    bodyProfiles: [{ profileId: 'default', heightCm: 170 }],
    summary: 'v1 摘要',
    globalSummary: 'v1 全局',
  })
  // 第二轮只更新会话摘要与追加消息
  memory.commitTurn(key, {
    appendMessages: [{ role: 'assistant', content: '第二轮' }],
    summary: 'v2 摘要',
  })

  const snap = memory.snapshot(key)
  assert.equal(snap.recentMessages.length, 2)
  assert.equal(snap.summary, 'v2 摘要')
  assert.deepEqual(snap.conversationProfile, { heightCm: 170 }, 'profile 未提供则保持原值')
  assert.deepEqual(snap.bodyProfiles, [{ profileId: 'default', heightCm: 170 }])
  assert.equal(snap.globalSummary, 'v1 全局')

  // 第三轮只更新客户维度，会话维度不动
  memory.commitTurn(key, { globalSummary: 'v3 全局' })
  const snap2 = memory.snapshot(key)
  assert.equal(snap2.globalSummary, 'v3 全局')
  assert.equal(snap2.summary, 'v2 摘要')
  assert.equal(snap2.recentMessages.length, 2)
})

// 深层嵌套的 profile 经 JSON 列写入再读出必须逐字段相等（round-trip 无损）。
test('memory repository: conversationProfile/bodyProfiles deep round-trip through JSON columns', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)
  const key = { customerId: 'c22', productId: 'SUIT-003', conversationId: 'c22:SUIT-003' }

  const profile = {
    heightCm: 182,
    weightKg: 75.5,
    productIntent: { currentProductText: '黑色双排扣', source: 'message', confirmed: true },
    orderReadiness: { needProductId: false, nextStep: '确认尺码', pending: null },
    tags: ['vip', '回头客'],
  }
  const bodyProfiles: JsonValue = [
    { profileId: 'default', label: '默认档案', heightCm: 182, weightKg: 75.5 },
    { profileId: 'kid', label: '孩子', heightCm: 120, notes: null },
  ]
  memory.commitTurn(key, { conversationProfile: profile, bodyProfiles })

  const snap = memory.snapshot(key)
  assert.deepEqual(snap.conversationProfile, profile)
  assert.deepEqual(snap.bodyProfiles, bodyProfiles)
})

// 滑窗截断与 profile 写入互不干扰：连续 25 轮既追加消息又更新 profile，
// 消息按上限截到 20 条，但 profile 始终是最后一轮的值；
// 之后单独 appendRecentMessages 也不得动 profile。
test('memory repository: sliding-window cap and profile writes do not interfere', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)
  const key = { customerId: 'c23', productId: 'p', conversationId: 'c23:p' }

  for (let i = 0; i < 25; i++) {
    memory.commitTurn(key, {
      appendMessages: [{ role: 'user', content: `m${i}` }],
      conversationProfile: { turn: i },
    })
  }
  let snap = memory.snapshot(key)
  assert.equal(snap.recentMessages.length, 20, '消息滑窗仍按默认 20 条截断')
  assert.equal((snap.recentMessages[0] as { content: string }).content, 'm5')
  assert.equal((snap.recentMessages[19] as { content: string }).content, 'm24')
  assert.deepEqual(snap.conversationProfile, { turn: 24 }, 'profile 不受截断影响，保留最新值')

  memory.appendRecentMessages(key, [{ role: 'user', content: 'm25' }])
  snap = memory.snapshot(key)
  assert.equal(snap.recentMessages.length, 20)
  assert.equal((snap.recentMessages[19] as { content: string }).content, 'm25')
  assert.deepEqual(snap.conversationProfile, { turn: 24 }, '纯消息追加不得改写 profile')
})

// 事务原子性：customer 行先写成功、product 行序列化失败时必须整体回滚，
// 不能留下半行（BigInt 无法 JSON.stringify，用它制造事务中途失败）。
test('memory repository: commitTurn is atomic — mid-transaction failure leaves no partial rows', () => {
  const db = freshDb()
  const memory = createMemoryRepository(db)
  const key = { customerId: 'c24', productId: 'SUIT-004', conversationId: 'c24:SUIT-004' }
  const poisoned = { big: BigInt(1) } as unknown as JsonValue

  // 首次提交即失败：两张表都不应出现任何行
  assert.throws(() =>
    memory.commitTurn(key, { globalSummary: '会被回滚', conversationProfile: poisoned }),
  )
  assert.equal(memory.getCustomer('c24'), undefined, 'customer 行必须随事务回滚')
  assert.equal(memory.getProduct('c24', 'SUIT-004', 'c24:SUIT-004'), undefined)

  // 先成功写入一轮，再让第二轮中途失败：两张表都必须保持第一轮的值
  memory.commitTurn(key, {
    appendMessages: [{ role: 'user', content: '第一轮' }],
    conversationProfile: { turn: 1 },
    globalSummary: 'v1 全局',
  })
  assert.throws(() =>
    memory.commitTurn(key, { globalSummary: 'v2 全局', conversationProfile: poisoned }),
  )
  const snap = memory.snapshot(key)
  assert.equal(snap.globalSummary, 'v1 全局', '失败事务里的 customer 更新必须回滚')
  assert.deepEqual(snap.conversationProfile, { turn: 1 })
  assert.equal(snap.recentMessages.length, 1)
})

// legacy JSON 回退路径也要补齐完整记忆字段，与 SQLite 路径同形状。
test('memory repository: legacy fallback hydrates the full memory fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatty-fallback-full-'))
  const legacyPath = join(dir, 'memory-store.json')
  writeFileSync(
    legacyPath,
    JSON.stringify({
      c25: {
        customerId: 'c25',
        globalSummary: 'legacy 全局摘要',
        sessionContext: {},
        bodyProfiles: [{ profileId: 'default', heightCm: 175 }],
        productMemories: {
          'c25:SUIT-001': {
            productId: 'SUIT-001',
            conversationId: 'c25:SUIT-001',
            summary: 'legacy 会话摘要',
            recentMessages: [{ role: 'user', content: 'legacy q' }],
            conversationProfile: { heightCm: 175 },
            reviews: [],
          },
        },
      },
    }),
  )

  const db = freshDb()
  const memory = createMemoryRepository(db, { legacyMemoryPath: legacyPath })
  const snap = memory.snapshot({
    customerId: 'c25',
    conversationId: 'c25:SUIT-001',
    productId: 'SUIT-001',
  })
  assert.deepEqual(snap.conversationProfile, { heightCm: 175 })
  assert.deepEqual(snap.bodyProfiles, [{ profileId: 'default', heightCm: 175 }])
  assert.equal(snap.summary, 'legacy 会话摘要')
  assert.equal(snap.globalSummary, 'legacy 全局摘要')
})
