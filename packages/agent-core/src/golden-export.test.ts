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
  // no issues => notContains is an empty list
  assert.ok(yaml.includes('notContains:'))
  assert.ok(yaml.includes('minScore:'))
})

test('export handles missing question/output gracefully', () => {
  const f = fc()
  f.input = {}
  f.output = undefined
  const { yaml } = exportFailureCaseToGoldenYaml(f)
  assert.ok(yaml.includes('user:'))
  assert.ok(yaml.includes('minScore:'))
})
