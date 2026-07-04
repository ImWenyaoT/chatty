// Smoke test: exercise the full data path WITHOUT a real LLM.
// Verifies: SQLite open, schema (incl. FKs), session/trace/review/failure repos,
// failure-case policy + golden export + promote CLI (the flywheel's last mile).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  openDatabase,
  createSessionRepository,
  createTraceRepository,
  createTraceReviewRepository,
  createFailureCaseRepository,
  createMemoryRepository,
} from '@rental/db'
import {
  shouldCreateFailureCase,
  deriveFailureCase,
  exportFailureCaseToGoldenYaml,
} from '@rental/agent-core'
import { promoteFailureCase } from './promote-failure-case.mts'

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
const reviews = createTraceReviewRepository(db)
const failures = createFailureCaseRepository(db)
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
  output: { reply: '不知道' },
})
ok('trace appended', t.id === 'smoke-tr')

// 2. review + failure case (simulating a low score)
// 这里的评分是 CI 冒烟用的硬编码模拟值（无 LLM 环境下驱动同一条数据链路）；
// 生产评分路径在 apps/web/app/api/playground/route.ts：trace 落库后 fire-and-forget
// 走 apps/web/lib/eval-chain.ts（LLM-judge → review → 低分晋升 failure_case）。
const review = {
  score: 3,
  issues: ['拒绝回答'],
  suggestions: ['给价'],
  suggestedReply: '199元',
  evaluatorModel: 'm',
  promptVersion: 'v1',
}
reviews.append({
  id: 'smoke-rev',
  traceId: 'smoke-tr',
  score: review.score,
  issues: review.issues,
  suggestions: review.suggestions,
  suggestedReply: review.suggestedReply,
})
ok('review persisted', reviews.findByTrace('smoke-tr').length === 1)

const shouldFail = shouldCreateFailureCase(review.score)
ok('low score triggers failure case', shouldFail === true)
if (shouldFail) {
  const trace = traces.queryBySession('smoke-sess').find((x) => x.id === 'smoke-tr')!
  const candidate = deriveFailureCase(trace, review)
  failures.create({
    id: 'smoke-fc',
    traceId: candidate.traceId,
    sessionId: candidate.sessionId,
    score: candidate.score,
    issues: candidate.issues,
    input: candidate.input,
    output: candidate.output,
  })
  ok('failure case created', failures.findOpen().length === 1)
}

// 3. golden export
const fc = failures.findOpen()[0]
const golden = exportFailureCaseToGoldenYaml({
  traceId: fc.traceId,
  sessionId: fc.sessionId,
  score: fc.score,
  issues: fc.issues,
  input: fc.input,
  output: fc.output,
})
ok('golden export has name', golden.yaml.includes('name:'))
ok('golden export has notContains', golden.yaml.includes('notContains:'))

// 3b. flywheel last mile: promote the open failure case through the CLI path —
// the golden YAML lands on disk and the case leaves the open queue.
const goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatty-golden-'))
const promoted = promoteFailureCase(failures, 'smoke-fc', goldenDir)
ok('promote writes the golden file', fs.existsSync(promoted.file))
ok('promoted yaml keeps the failing issue', promoted.yaml.includes('拒绝回答'))
ok('promoted case leaves the open queue', failures.findOpen().length === 0)

// 4. FK enforcement (orphan rejected)
let fkRejected = false
try {
  failures.create({
    id: 'orphan',
    traceId: 'nope',
    sessionId: 'nope',
    score: 1,
    issues: [],
    input: {},
  })
} catch {
  fkRejected = true
}
ok('FK rejects orphan failure case', fkRejected === true)

// 5. memory continuity: appended turns accumulate and a later snapshot reads
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
