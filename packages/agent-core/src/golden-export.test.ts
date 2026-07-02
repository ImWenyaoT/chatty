import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportFailureCaseToGoldenYaml } from './golden-export.js'
import type { FailureCaseCandidate } from './failure-case-policy.js'

const fc = (): FailureCaseCandidate => ({
  traceId: 'tr-abc',
  sessionId: 'sess-1',
  score: 3,
  issues: ['拒绝回答', '态度差'],
  input: { question: '多少钱' },
  output: { reply: '不知道' },
})

test('export produces a filename derived from the trace id', () => {
  const { filename } = exportFailureCaseToGoldenYaml(fc())
  assert.equal(filename, 'regression-tr-abc.yaml')
})

test('export filename sanitizes non-alphanumeric chars', () => {
  const f = fc()
  f.traceId = 'tr/Weird:ID'
  const { filename } = exportFailureCaseToGoldenYaml(f)
  assert.match(filename, /^regression-[a-z0-9-]+\.yaml$/)
})

test('exported yaml contains the golden schema tokens', () => {
  const { yaml } = exportFailureCaseToGoldenYaml(fc())
  assert.ok(yaml.includes('name:'), 'missing name:')
  assert.ok(yaml.includes('customerId:'), 'missing customerId:')
  assert.ok(yaml.includes('steps:'), 'missing steps:')
  assert.ok(yaml.includes('user:'), 'missing user:')
  assert.ok(yaml.includes('expect:'), 'missing expect:')
  assert.ok(yaml.includes('notContains:'), 'missing notContains:')
  assert.ok(yaml.includes('minScore:'), 'missing minScore:')
})

test('exported yaml carries the failing question as the step user input', () => {
  const { yaml } = exportFailureCaseToGoldenYaml(fc())
  assert.ok(yaml.includes('多少钱'), 'question not embedded')
})

test('exported yaml lists each issue under notContains', () => {
  const { yaml } = exportFailureCaseToGoldenYaml(fc())
  assert.ok(yaml.includes('拒绝回答'), 'issue 1 missing')
  assert.ok(yaml.includes('态度差'), 'issue 2 missing')
})

test('exported yaml records the original score', () => {
  const { yaml } = exportFailureCaseToGoldenYaml(fc())
  assert.ok(yaml.includes('original score: 3'), 'score not recorded')
})

test('export with no issues still emits valid yaml', () => {
  const f = fc()
  f.issues = []
  const { yaml } = exportFailureCaseToGoldenYaml(f)
  // no issues => notContains is an inline empty list, and minScore stays on its
  // own indented line. The previous implementation produced "notContains:\n[]minScore: 6",
  // a single corrupt line that breaks the golden YAML parser.
  assert.ok(yaml.includes('notContains: []'), 'empty issues should yield an inline empty list')
  assert.ok(!yaml.includes('[]minScore'), 'notContains and minScore must not be concatenated')
  assert.match(yaml, /\n\s+minScore: 6/, 'minScore must be on its own indented line')
})

test('export handles missing question/output gracefully', () => {
  const f = fc()
  f.input = {}
  f.output = undefined
  const { yaml } = exportFailureCaseToGoldenYaml(f)
  assert.ok(yaml.includes('user:'))
  assert.ok(yaml.includes('minScore:'))
})

// --- grill #2: YAML escaping for special-character values -----------------
// Issues containing : or # or quotes must be double-quote escaped so the
// exported YAML stays parseable (otherwise "价格: 未说明" would break the parser).

test('export escapes issues containing a colon with double quotes', () => {
  const f = fc()
  f.issues = ['价格: 未说明', '态度差']
  const { yaml } = exportFailureCaseToGoldenYaml(f)
  // the colon-bearing issue must be quoted; the plain one need not be
  assert.ok(yaml.includes('"价格: 未说明"'), 'colon-bearing issue should be quoted')
  assert.ok(yaml.includes('- 态度差'))
})

test('export escapes issues containing a hash', () => {
  const f = fc()
  f.issues = ['问题#1']
  const { yaml } = exportFailureCaseToGoldenYaml(f)
  assert.ok(yaml.includes('"问题#1"'))
})

test('export escapes issues containing double quotes by backslash-escaping them', () => {
  const f = fc()
  f.issues = ['他说"不行"']
  const { yaml } = exportFailureCaseToGoldenYaml(f)
  // 内层双引号必须反斜杠转义、整体用双引号包裹，否则导出的 YAML 解析会碎
  assert.ok(yaml.includes('"他说\\"不行\\""'), 'inner quotes must be escaped and wrapped')
})

test('export of special-character issues still contains minScore and user tokens', () => {
  const f = fc()
  f.issues = ['价格: 未说明', '另一个#问题']
  const { yaml } = exportFailureCaseToGoldenYaml(f)
  assert.ok(yaml.includes('minScore:'))
  assert.ok(yaml.includes('user:'))
  assert.ok(yaml.includes('notContains:'))
})
