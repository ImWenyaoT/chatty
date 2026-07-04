// createComposeModelFn 的单元测试：CHATTY_LLM=1 的 LLM compose 接线必须复用
// completeJson 的容错 JSON 提取。OpenAI 兼容端点（含默认的 DeepSeek）即使被
// 系统提示词禁止，也常把 JSON 包进 ```json 代码块或前后夹说明文字——这类回复
// 必须仍产出正确 action，而不是静默落到 fallbackAction 的通用话术；完全不可
// 解析时 modelFn 抛错，由 composeCustomerServiceModelOutput 回退确定性 composer。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversationEvent, MemorySnapshot } from '@rental/shared'
import { createDefaultToolRegistry, runCustomerServiceHarnessStep } from '@rental/agent-core'
import { type ChatCompletionsAdapter, parseJsonObject } from '@rental/llm'
import { createComposeModelFn, createPlaygroundModelFn } from './llm'

/** 造一条带商品上下文的用户消息事件，复用 harness 测试的最小形状。 */
function userEvent(question: string): ConversationEvent {
  return {
    eventId: 'evt_1',
    type: 'user_message',
    customerId: 'c',
    conversationId: 'c:SUIT-001',
    productId: 'SUIT-001',
    source: 'customer',
    payload: { question },
    occurredAt: '2026-07-03T00:00:00.000Z',
    traceId: 'tr_1',
  }
}

/** 最小记忆快照：无历史消息、锁定测试商品。 */
function memory(): MemorySnapshot {
  return {
    customerId: 'c',
    conversationId: 'c:SUIT-001',
    productId: 'SUIT-001',
    recentMessages: [],
  }
}

/**
 * 造一个固定回复的 fake adapter：complete 返回原始文本，completeJson 与真实
 * 适配器一致地走 parseJsonObject 容错提取——若接线回退到 complete()，fenced
 * 输出会原样穿透并在下游解析失败，从而让用例失败。
 */
function fixedReplyAdapter(rawReply: string): ChatCompletionsAdapter {
  return {
    complete: async () => rawReply,
    completeJson: async <T>() => parseJsonObject<T>(rawReply),
  }
}

test('fenced JSON 输出仍产出正确 action（不落 fallbackAction 通用话术）', async () => {
  const modelFn = createComposeModelFn(
    fixedReplyAdapter(
      '```json\n{"action":"answer_question","reply":"这款 L 码 5月10到12号可以安排。"}\n```',
    ),
  )
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款有 L 吗，5月10到12号穿'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelFn,
  })

  assert.equal(result.trace.action.action, 'answer_question')
  assert.equal(result.step.reply, '这款 L 码 5月10到12号可以安排。')
})

test('JSON 前后夹杂说明文字时仍产出正确 action', async () => {
  const modelFn = createComposeModelFn(
    fixedReplyAdapter(
      '好的，结论如下：{"action":"answer_question","reply":"日租 199 元。"} 请查收',
    ),
  )
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款多少钱'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelFn,
  })

  assert.equal(result.trace.action.action, 'answer_question')
  assert.equal(result.step.reply, '日租 199 元。')
})

test('完全不可解析的回复让 modelFn 抛错，回退确定性 composer 而非 fallbackAction', async () => {
  const modelFn = createComposeModelFn(fixedReplyAdapter('抱歉，我无法以 JSON 回答'))
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款有 L 吗，5月10到12号穿'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelFn,
  })

  // 同一输入下确定性 composer 会给出 check_availability 工具动作，
  // 绝不是解析器 fallbackAction 的“我先帮您确认一下，再继续处理。”
  assert.equal(result.trace.action.action, 'check_availability')
  assert.equal(result.trace.action.toolName, 'check_availability')
  assert.notEqual(result.step.reply, '我先帮您确认一下，再继续处理。')
})

test('createPlaygroundModelFn 双重门控：CHATTY_LLM 未开或缺 API key 时返回 undefined', () => {
  const savedLlm = process.env.CHATTY_LLM
  const savedKey = process.env.OPENAI_API_KEY
  try {
    process.env.CHATTY_LLM = ''
    process.env.OPENAI_API_KEY = 'sk-test'
    assert.equal(createPlaygroundModelFn(), undefined)

    process.env.CHATTY_LLM = '1'
    process.env.OPENAI_API_KEY = ''
    assert.equal(createPlaygroundModelFn(), undefined)

    process.env.OPENAI_API_KEY = 'sk-test'
    assert.equal(typeof createPlaygroundModelFn(), 'function')
  } finally {
    // 恢复环境变量，避免污染同进程的其他用例
    if (savedLlm === undefined) delete process.env.CHATTY_LLM
    else process.env.CHATTY_LLM = savedLlm
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
  }
})
