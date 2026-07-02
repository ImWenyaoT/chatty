// 意图路由器 classifyAction 的单元测试：这是 loop 的第一道安全兜底——
// 分类器本身不可信（LLM 可能抛错/幻觉出非法类别），任何失败都必须
// 回退到 ask_info（有知识库兜底的路径），保证客户永远不会被卡死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatCompletionMessage, ChatCompletionsAdapter } from '@rental/llm'
import { classifyAction, type ActionClass } from './action-classifier.js'

// 构造只实现 completeJson 的假 LLM 适配器，隔离真实网络调用
function fakeAdapter(
  impl: (messages: ChatCompletionMessage[]) => Promise<unknown>,
): ChatCompletionsAdapter {
  return {
    async complete() {
      throw new Error('classifyAction 不应调用 complete')
    },
    async completeJson<T>(messages: ChatCompletionMessage[]) {
      return (await impl(messages)) as T
    },
  }
}

test('四类合法 actionClass 原样透传，reason/reply 一并带回', async () => {
  const classes: ActionClass[] = ['small_talk', 'ask_info', 'provide_info', 'handoff']
  for (const cls of classes) {
    const llm = fakeAdapter(async () => ({
      actionClass: cls,
      reason: '模型给的理由',
      reply: '好的',
    }))
    const result = await classifyAction(llm, '随便一句话')
    assert.equal(result.actionClass, cls)
    assert.equal(result.reason, '模型给的理由')
    assert.equal(result.reply, '好的')
  }
})

test('空消息短路为 small_talk，完全不调用 LLM', async () => {
  let calls = 0
  const llm = fakeAdapter(async () => {
    calls += 1
    return { actionClass: 'ask_info', reason: 'should not happen' }
  })
  const result = await classifyAction(llm, '   ')
  assert.equal(result.actionClass, 'small_talk')
  assert.ok(result.reply, '空消息也要给一句兜底回复')
  assert.equal(calls, 0)
})

test('adapter 抛错时安全回退 ask_info，reason 记录错误现场', async () => {
  const llm = fakeAdapter(async () => {
    throw new Error('boom: upstream 500')
  })
  const result = await classifyAction(llm, '这件多少钱')
  assert.equal(result.actionClass, 'ask_info')
  assert.match(result.reason, /classifier_error/)
  assert.match(result.reason, /boom: upstream 500/)
  assert.equal(result.reply, undefined)
})

test('返回非法 actionClass 枚举时回退 ask_info（安全兜底不变量）', async () => {
  const llm = fakeAdapter(async () => ({ actionClass: 'buy_now', reason: '幻觉出的类别' }))
  const result = await classifyAction(llm, '这件多少钱')
  assert.equal(result.actionClass, 'ask_info')
})

test('reason 缺失补默认值，reply 空串归一为 undefined', async () => {
  const llm = fakeAdapter(async () => ({ actionClass: 'ask_info', reason: '', reply: '' }))
  const result = await classifyAction(llm, '有货吗')
  assert.equal(result.actionClass, 'ask_info')
  assert.equal(result.reason, 'ask_info (no reason)')
  assert.equal(result.reply, undefined)
})

test('发给分类器的消息是 system prompt 加 trim 后的用户原话', async () => {
  let captured: ChatCompletionMessage[] = []
  const llm = fakeAdapter(async (messages) => {
    captured = messages
    return { actionClass: 'small_talk', reason: '寒暄' }
  })
  await classifyAction(llm, '  在吗  ')
  assert.equal(captured.length, 2)
  assert.equal(captured[0].role, 'system')
  assert.equal(captured[1].role, 'user')
  assert.equal(captured[1].content, '在吗')
})
