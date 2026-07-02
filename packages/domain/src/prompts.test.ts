// prompt 版本哈希与 {{var}} 模板渲染的单元测试。
// promptVersion 的算法（sha1 前 6 位 + 版本名前缀 + '\n---\n' 拼接）是跨实现契约：
// 同一份 YAML 在 legacy 与重写实现下必须算出同一个版本号，评分对比才不断档。
import assert from 'node:assert/strict'
import test from 'node:test'
import { computePromptVersion, renderTemplate, shortHash } from './prompts.js'

test('computePromptVersion：固定输入产出固定哈希（钉死算法，防止悄悄换实现）', () => {
  // 期望值 = sha1('prompts-raw\n---\ncatalog-raw') 前 6 位，与 legacy shortHash 算法一致
  assert.equal(computePromptVersion('v1', 'prompts-raw', 'catalog-raw'), 'v1-725b2d')
})

test('computePromptVersion：确定性——同输入恒等，输出格式为 <版本名>-<6位十六进制>', () => {
  const a = computePromptVersion('v2', 'foo', 'bar')
  const b = computePromptVersion('v2', 'foo', 'bar')
  assert.equal(a, b)
  assert.match(a, /^v2-[0-9a-f]{6}$/)
})

test('computePromptVersion：prompts 或 catalog 任一字变动都产生新版本号', () => {
  const base = computePromptVersion('v1', 'foo', 'bar')
  assert.notEqual(computePromptVersion('v1', 'foo!', 'bar'), base)
  assert.notEqual(computePromptVersion('v1', 'foo', 'bar!'), base)
})

test('computePromptVersion：拼接带分隔符——(a,b) 与 (a+b,"") 不会撞出同一哈希', () => {
  assert.notEqual(computePromptVersion('v1', 'ab', 'c'), computePromptVersion('v1', 'a', 'bc'))
})

test('shortHash：输出 6 位十六进制且稳定', () => {
  assert.equal(shortHash('hello'), shortHash('hello'))
  assert.match(shortHash('hello'), /^[0-9a-f]{6}$/)
})

test('renderTemplate：替换 {{var}} 占位符，允许花括号内有空白', () => {
  const out = renderTemplate('会话历史：{{historyText}}，回复：{{ reply }}', {
    historyText: '用户：在吗',
    reply: '在的',
  })
  assert.equal(out, '会话历史：用户：在吗，回复：在的')
})

test('renderTemplate：未提供的变量替换为空串，而不是保留占位符', () => {
  assert.equal(renderTemplate('前{{missing}}后', {}), '前后')
})
