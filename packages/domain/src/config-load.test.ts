// loadDomainConfig 的单元测试：读真实的 packages/domain/config/（行为契约 YAML），
// 以及用临时目录构造缺字段场景验证校验逻辑。
// 关键契约：加载只在显式调用时发生（本文件 import 不触发任何 fs 读取）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadDomainConfig } from './config-load.js'

// 包内真实 config 目录：src/ 的上一级
const realConfigDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config')

/** 在系统临时目录下搭一个最小 config 树，按需破坏指定文件内容 */
function makeTempConfig(overrides: { prompts?: string; catalog?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-config-'))
  fs.mkdirSync(path.join(dir, 'prompts'))
  const prompts =
    overrides.prompts ??
    [
      'stylistPrompt: a',
      'systemSupplement: b',
      'evaluatorSystemPrompt: c',
      'evaluatorUserTemplate: d',
      'factExtractorSystemPrompt: e',
    ].join('\n')
  const catalog =
    overrides.catalog ??
    ['products: []', 'sizeRules: []', 'sizeFallback:', '  size: X', '  confidence: low'].join('\n')
  fs.writeFileSync(path.join(dir, 'prompts', 'v1.yaml'), prompts)
  fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalog)
  return dir
}

test('loadDomainConfig：加载真实 config，五个 prompt 字段齐全、catalog 结构完整', () => {
  const loaded = loadDomainConfig(realConfigDir)
  assert.equal(loaded.versionName, 'v1')
  assert.ok(loaded.prompts.stylistPrompt.length > 0)
  assert.ok(loaded.prompts.systemSupplement.includes('R1'))
  assert.ok(loaded.prompts.evaluatorSystemPrompt.length > 0)
  assert.ok(loaded.prompts.evaluatorUserTemplate.includes('{{historyText}}'))
  assert.ok(loaded.prompts.factExtractorSystemPrompt.length > 0)
  assert.ok(Array.isArray(loaded.catalog.products))
  assert.equal(loaded.catalog.products[0]?.id, 'SUIT-001')
  assert.ok(loaded.catalog.sizeRules.length >= 3)
  assert.equal(loaded.catalog.sizeFallback.size, '尺码待人工确认')
})

test('loadDomainConfig：promptVersion 形如 v1-<6位哈希> 且两次加载一致', () => {
  const a = loadDomainConfig(realConfigDir)
  const b = loadDomainConfig(realConfigDir)
  assert.match(a.promptVersion, /^v1-[0-9a-f]{6}$/)
  assert.equal(a.promptVersion, b.promptVersion)
})

test('loadDomainConfig：prompts 缺任一必填字段即抛错，错误信息带文件路径与字段名', () => {
  const dir = makeTempConfig({
    prompts: ['stylistPrompt: a', 'systemSupplement: b'].join('\n'),
  })
  assert.throws(() => loadDomainConfig(dir), /missing field: evaluatorSystemPrompt/)
})

test('loadDomainConfig：catalog 缺 products / sizeRules 数组即抛错', () => {
  const noProducts = makeTempConfig({ catalog: 'sizeRules: []' })
  assert.throws(() => loadDomainConfig(noProducts), /missing products array/)

  const noRules = makeTempConfig({ catalog: 'products: []' })
  assert.throws(() => loadDomainConfig(noRules), /missing sizeRules array/)
})

test('loadDomainConfig：versionName 可指定，找不到对应 prompts 文件时抛 fs 错误', () => {
  const dir = makeTempConfig()
  assert.throws(() => loadDomainConfig(dir, 'v9'))
  // 显式传 v1 与缺省等价
  const loaded = loadDomainConfig(dir, 'v1')
  assert.equal(loaded.versionName, 'v1')
  assert.match(loaded.promptVersion, /^v1-[0-9a-f]{6}$/)
})
