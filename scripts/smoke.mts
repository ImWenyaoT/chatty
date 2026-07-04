// Smoke test: exercise the core data path WITHOUT a real LLM.
// Verifies: SQLite open, schema, session/trace repos, and memory continuity —
// the persistence contracts the playground route depends on. The eval flywheel
// (auto-scoring → failure_case → golden promotion) has been retired; quality
// regression now lives in `pnpm eval --target harness` (plain golden check).
import {
  openDatabase,
  createSessionRepository,
  createTraceRepository,
  createMemoryRepository,
} from '@rental/db'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean) => {
  if (cond) {
    pass++
    console.log('  PASS', name)
  } else {
    fail++
    console.log('  FAIL', name)
  }
}

const db = openDatabase(':memory:')
const sessions = createSessionRepository(db)
const traces = createTraceRepository(db)
const memory = createMemoryRepository(db)

// 1. session + trace
const s = sessions.create({
  id: 'smoke-sess',
  customerId: 'c',
  conversationId: 'c:SUIT-001',
  productId: 'SUIT-001',
})
ok('session created', s.status === 'active')
const t = traces.append({
  id: 'smoke-tr',
  sessionId: 'smoke-sess',
  eventType: 'agent_reply_sent',
  input: { question: '多少钱' },
  output: { reply: '日租 199 元' },
})
ok('trace appended', t.id === 'smoke-tr')
ok(
  'trace read back by session',
  traces.queryBySession('smoke-sess').some((x) => x.id === 'smoke-tr'),
)

// 2. memory continuity: appended turns accumulate and a later snapshot reads
// them back (the write path the route uses to avoid conversational amnesia).
const memKey = { customerId: 'c', productId: 'SUIT-001', conversationId: 'c:SUIT-001' }
memory.appendRecentMessages(memKey, [
  { role: 'user', content: '多少钱' },
  { role: 'assistant', content: '日租 199 元' },
])
memory.appendRecentMessages(memKey, [{ role: 'user', content: '尺码有 L 吗' }])
const memSnap = memory.snapshot(memKey)
ok('memory continuity: recentMessages accumulate across turns', memSnap.recentMessages.length === 3)

console.log(`\nSmoke result: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
