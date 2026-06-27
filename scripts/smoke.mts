// Smoke test: exercise the full data path WITHOUT a real LLM.
// Verifies: SQLite open, schema (incl. FKs), session/trace/review/failure repos,
// failure-case policy + golden export, knowledge adapter + evaluator injection.
import {
  openDatabase,
  createSessionRepository,
  createTraceRepository,
  createTraceReviewRepository,
  createFailureCaseRepository,
  createMemoryRepository,
} from '@rental/db'
import {
  createKnowledgeAdapter,
  shouldCreateFailureCase,
  deriveFailureCase,
  exportFailureCaseToGoldenYaml,
  createEvaluator,
} from '@rental/agent-core'

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
createMemoryRepository(db) // ensure memory repo constructs (JSON fallback path)

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

// 4. knowledge adapter injection
const knowledge = createKnowledgeAdapter(async () => [
  { score: 0.9, payload: { text: '199元/天' } },
])
const hits = await knowledge.search({ question: '多少钱' })
ok('knowledge adapter returns hits', hits.length === 1)

// 5. evaluator injection
const evaluator = createEvaluator(async () => review)
const evalResult = await evaluator.evaluate([{ role: 'user', content: '多少钱' }], '不知道')
ok('evaluator returns score', evalResult.score === 3)

// 6. FK enforcement (orphan rejected)
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

console.log(`\nSmoke result: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
