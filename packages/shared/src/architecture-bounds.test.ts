import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_ARCHITECTURE_REFERENCE_CHOICES,
  AGENT_COMPLEXITY_BOUNDS,
  ARCHITECTURE_COMPLEXITY_POLICY,
  getPrimaryReferenceByTopic,
  isAllowedArchitectureReference,
} from './architecture-bounds.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const currentDocRoot = resolve(repoRoot, 'docs')
const disallowedCurrentReferencePattern = /\b(Hermes|Pi Agent|pi agent|opencode|OpenCode)\b/

/** 递归列出当前文档区 Markdown 文件，archive 下的历史记录不参与当前架构约束。 */
function listCurrentMarkdownDocs(dir: string): string[] {
  const entries = readdirSync(dir).flatMap((entry) => {
    const absolute = join(dir, entry)
    const rel = relative(currentDocRoot, absolute)
    if (rel === 'archive' || rel.startsWith(`archive/`)) return []
    if (rel === 'jd.md') return []
    if (statSync(absolute).isDirectory()) return listCurrentMarkdownDocs(absolute)
    return absolute.endsWith('.md') ? [absolute] : []
  })
  return entries.sort()
}

test('agent complexity bounds stay between jd plus PRD and the reference agent source code', () => {
  assert.deepEqual(AGENT_COMPLEXITY_BOUNDS.lowerBound, ['docs/jd.md', 'PRD.pdf'])
  assert.deepEqual(AGENT_COMPLEXITY_BOUNDS.upperBound, [
    '/Users/edward/Documents/oss/openclaw',
    '/Users/edward/Documents/oss/codex',
    '/Users/edward/Documents/oss/claude-code',
  ])
})

test('architecture complexity policy prefers deletion over optimizing out-of-bounds work', () => {
  assert.equal(ARCHITECTURE_COMPLEXITY_POLICY.target, 'stay-inside-bounds')
  assert.equal(ARCHITECTURE_COMPLEXITY_POLICY.lowerBoundAction, 'raise-to-jd-and-prd')
  assert.equal(ARCHITECTURE_COMPLEXITY_POLICY.upperBoundAction, 'delete-before-optimizing')
  assert.match(ARCHITECTURE_COMPLEXITY_POLICY.rule, /先删除/)
})

test('only explicit reference agents can be used in architecture design choices', () => {
  assert.ok(isAllowedArchitectureReference('openclaw'))
  assert.ok(isAllowedArchitectureReference('codex'))
  assert.ok(isAllowedArchitectureReference('claude-code'))
  assert.equal(isAllowedArchitectureReference('hermes'), false)
  assert.equal(isAllowedArchitectureReference('pi'), false)
})

test('each documented agent architecture topic declares exactly one primary reference', () => {
  const topics = AGENT_ARCHITECTURE_REFERENCE_CHOICES.map((choice) => choice.topic)
  assert.deepEqual(topics, [
    'task scheduling 拆分',
    '如何实现 multi agent',
    'loop 和流程控制',
    '如何更好控制整个 loop 和 workflow',
    '如何做可视化、可观测性与 terminal UI',
    'input 拼接 prompt',
    '如何实现 long-term memory',
    '如何实现 skills 和 plugins',
    '如何做好 context auto compression',
    'output parser',
    '执行器 executor',
    '如何设计可以自由配置的 mcp',
    '如何做好 eval 和自动化测试',
    'terminal 执行',
    '如何控制 sandbox 环境',
    '如何管理 background tasks',
    'terminal 读 output',
    '基本 file I/O（读、写、搜）',
  ])

  const byTopic = getPrimaryReferenceByTopic()
  assert.equal(byTopic['task scheduling 拆分'], 'codex')
  assert.equal(byTopic['如何实现 multi agent'], 'codex')
  assert.equal(byTopic['loop 和流程控制'], 'codex')
  assert.equal(byTopic['如何更好控制整个 loop 和 workflow'], 'codex')
  assert.equal(byTopic['如何做可视化、可观测性与 terminal UI'], 'codex')
  assert.equal(byTopic['input 拼接 prompt'], 'codex')
  assert.equal(byTopic['如何实现 long-term memory'], 'openclaw')
  assert.equal(byTopic['如何实现 skills 和 plugins'], 'claude-code')
  assert.equal(byTopic['如何做好 context auto compression'], 'codex')
  assert.equal(byTopic['output parser'], 'codex')
  assert.equal(byTopic['执行器 executor'], 'codex')
  assert.equal(byTopic['如何设计可以自由配置的 mcp'], 'claude-code')
  assert.equal(byTopic['如何做好 eval 和自动化测试'], 'codex')
  assert.equal(byTopic['terminal 执行'], 'codex')
  assert.equal(byTopic['如何控制 sandbox 环境'], 'codex')
  assert.equal(byTopic['如何管理 background tasks'], 'codex')
  assert.equal(byTopic['terminal 读 output'], 'codex')
  assert.equal(byTopic['基本 file I/O（读、写、搜）'], 'claude-code')
})

test('current architecture docs do not cite retired reference agents outside archive', () => {
  const offenders = listCurrentMarkdownDocs(currentDocRoot).flatMap((file) => {
    const content = readFileSync(file, 'utf8')
    return disallowedCurrentReferencePattern.test(content) ? [relative(repoRoot, file)] : []
  })
  assert.deepEqual(offenders, [])
})
