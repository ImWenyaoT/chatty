import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationEvent, MemorySnapshot } from '@rental/shared'
import {
  buildCustomerServiceContext,
  createDefaultToolRegistry,
  createCustomerServiceModelOutput,
  CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
  executeCustomerServiceAction,
  MAX_SEARCH_CALLS,
  parseCustomerServiceOutput,
  runCustomerServiceHarnessStep,
  scheduleCustomerServiceTask,
  type CustomerServiceLoopMessage,
  type CustomerServiceToolLoopFn,
} from './index.js'

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

function memory(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    customerId: 'c',
    conversationId: 'c:SUIT-001',
    productId: 'SUIT-001',
    recentMessages: [],
    ...overrides,
  }
}

test('scheduler maps size-and-date slot collection to check_availability when required context is present', () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent('5月10到5月12，身高 179 体重 70kg，有 L 吗'),
    memory: memory(),
  })

  assert.equal(task.kind, 'check_availability')
  assert.equal(task.terminality, 'tool_then_continue')
  assert.deepEqual(task.requiredContext, ['productId', 'rentalPeriod', 'bodyMeasurements'])
})

test('compose instructions define harness, output, action and tool contracts', () => {
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /## Harness contract/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /## Operating style/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /## Output contract/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /## Action contract/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /## Tool contract/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /清晰、务实、严谨/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /当前任务边界/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /最终只能输出一个 JSON 对象/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /库存档期问题不要调用 search_knowledge/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /事实核验/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /禁止出现这些内部词/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /已经有 productId/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /系统会自动/)
  assert.match(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS, /不要编造/)
})

test('scheduler routes complaints and refunds to handoff instead of auto reply', () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent('我要投诉，给我退款'),
    memory: memory(),
  })

  assert.equal(task.kind, 'handoff')
  assert.equal(task.terminality, 'handoff_and_wait')
  assert.equal(task.risk, 'medium')
})

test('scheduler routes answerable policy questions to answer_question before slot collection', () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent('西装押金规则是什么？请先查知识库再回答'),
    memory: memory(),
  })

  assert.equal(task.kind, 'answer_question')
  assert.equal(task.terminality, 'reply_and_wait')
})

test('scheduler still collects missing product for product-specific price questions', () => {
  const event = {
    ...userEvent('这款多少钱一天？'),
    productId: undefined,
  }
  const task = scheduleCustomerServiceTask({
    event,
    memory: memory({ productId: undefined }),
  })

  assert.equal(task.kind, 'collect_missing_info')
})

test('context builder keeps ordered fragments for prompt assembly and inspection', () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent('这款多少钱'),
    memory: memory({ recentMessages: [{ role: 'assistant', content: '上一轮回复' }] }),
  })
  const context = buildCustomerServiceContext({
    event: userEvent('这款多少钱'),
    memory: memory({ recentMessages: [{ role: 'assistant', content: '上一轮回复' }] }),
    task,
  })

  assert.deepEqual(
    context.fragments.map((fragment) => fragment.kind),
    ['task', 'user_message', 'memory', 'product'],
  )
  assert.ok(context.prompt.includes('当前客服任务'))
  assert.ok(context.prompt.includes('SUIT-001'))
})

test('output parser accepts strict JSON actions and falls back to answer_question on invalid output', () => {
  const parsed = parseCustomerServiceOutput(
    '{"action":"check_availability","reply":"我先帮您查库存","toolName":"check_availability","toolArgs":{"productId":"SUIT-001","size":"L"}}',
  )
  assert.equal(parsed.action, 'check_availability')
  assert.equal(parsed.toolName, 'check_availability')

  const fallback = parseCustomerServiceOutput('不是 JSON')
  assert.equal(fallback.action, 'answer_question')
  assert.equal(fallback.reply, '我先帮您确认一下，再继续处理。')
})

test('model output composer turns scheduled tasks into constrained customer-service actions', () => {
  const event = userEvent('这款有 L 吗，5月10到12号穿')
  const task = scheduleCustomerServiceTask({ event, memory: memory() })
  const parsed = parseCustomerServiceOutput(
    createCustomerServiceModelOutput({
      event,
      memory: memory(),
      task,
    }),
  )

  assert.equal(parsed.action, 'check_availability')
  assert.equal(parsed.toolName, 'check_availability')
  assert.deepEqual(parsed.toolArgs, { productId: 'SUIT-001', size: 'L' })
})

test('executor runs low-risk availability checks through the tool registry', async () => {
  const result = await executeCustomerServiceAction({
    action: {
      action: 'check_availability',
      reply: '我先帮您查一下。',
      toolName: 'check_availability',
      toolArgs: { productId: 'SUIT-001', size: 'L' },
    },
    registry: createDefaultToolRegistry(),
    sessionStatus: 'active',
  })

  assert.equal(result.terminality, 'tool_then_continue')
  assert.equal(result.nextStatus, 'waiting_for_user')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].toolName, 'check_availability')
})

test('executor keeps attempted medium-risk tool calls in trace when approval is required', async () => {
  const result = await executeCustomerServiceAction({
    action: {
      action: 'handoff',
      reply: '我帮您转人工处理。',
      toolName: 'create_handoff',
      toolArgs: { conversationId: 'c:SUIT-001', reason: '用户要求退款' },
    },
    registry: createDefaultToolRegistry(),
    sessionStatus: 'active',
  })

  assert.equal(result.terminality, 'handoff_and_wait')
  assert.equal(result.nextStatus, 'waiting_for_human')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].toolName, 'create_handoff')
  assert.equal(result.toolResults.length, 1)
  assert.match(JSON.stringify(result.toolResults[0]), /ApprovalRequiredError/)
})

test('compose step routes through the injected modelFn with the built context prompt', async () => {
  let seenPrompt: string | undefined
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款有 L 吗，5月10到12号穿'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelFn: async (prompt) => {
      seenPrompt = prompt
      return '{"action":"answer_question","reply":"这款 L 码 5月10到12号可以安排。"}'
    },
  })

  assert.ok(seenPrompt?.includes('当前客服任务'))
  assert.ok(seenPrompt?.includes('SUIT-001'))
  assert.equal(result.trace.action.action, 'answer_question')
  assert.equal(result.step.reply, '这款 L 码 5月10到12号可以安排。')
})

test('compose step falls back to the deterministic composer when the modelFn fails', async () => {
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款有 L 吗，5月10到12号穿'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelFn: async () => {
      throw new Error('provider down')
    },
  })

  // 同一输入下确定性 composer 会给出 check_availability 工具动作
  assert.equal(result.trace.action.action, 'check_availability')
  assert.equal(result.trace.action.toolName, 'check_availability')
})

test('unparseable modelFn output falls back to the safe answer action via the parser', async () => {
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款有 L 吗，5月10到12号穿'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelFn: async () => '抱歉，这不是一个 JSON 回复',
  })

  assert.equal(result.trace.action.action, 'answer_question')
  assert.equal(result.step.reply, '我先帮您确认一下，再继续处理。')
})

test('harness step returns a bounded trace with task, context, action and memory patch', async () => {
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款有 L 吗，5月10到12号穿'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelOutput:
      '{"action":"check_availability","reply":"我先帮您查一下 L 码档期。","toolName":"check_availability","toolArgs":{"productId":"SUIT-001","size":"L"}}',
  })

  assert.equal(result.step.terminality, 'tool_then_continue')
  assert.equal(result.trace.task.kind, 'check_availability')
  assert.equal(result.trace.action.action, 'check_availability')
  assert.equal(result.trace.toolCalls.length, 1)
  assert.deepEqual(result.step.memoryPatch, {
    lastHarnessTask: 'check_availability',
    lastHarnessAction: 'check_availability',
  })
})

test('harness summarizes availability tool result in the customer reply', async () => {
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('黑色三件套西装 2026-05-10 到 2026-05-12 L 码有货吗？'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelOutput:
      '{"action":"check_availability","reply":"我先帮您查一下。","toolName":"check_availability","toolArgs":{"productId":"SUIT-001","startDate":"2026-05-10","endDate":"2026-05-12","size":"L"}}',
  })

  assert.equal(result.step.terminality, 'tool_then_continue')
  assert.equal(typeof result.step.reply, 'string')
  assert.match(result.step.reply ?? '', /L 码/)
  assert.match(result.step.reply ?? '', /2026-05-10 到 2026-05-12/)
  assert.match(result.step.reply ?? '', /可以安排/)
  assert.equal(result.trace.toolResults.length, 1)
})

test('compose step does not expose knowledge search loop for availability tasks', async () => {
  let modelCalls = 0
  let loopCalls = 0
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('黑色三件套西装 2026-05-10 到 2026-05-12 L 码有货吗？'),
    memory: memory(),
    registry: createDefaultToolRegistry(knowledgeSearcher([])),
    modelFn: async () => {
      modelCalls += 1
      return '{"action":"check_availability","reply":"我先帮您查库存。","toolName":"check_availability","toolArgs":{"productId":"SUIT-001","startDate":"2026-05-10","endDate":"2026-05-12","size":"L"}}'
    },
    toolLoopFn: async () => {
      loopCalls += 1
      return { text: '{"action":"answer_question","reply":"不应该走搜索循环。"}' }
    },
  })

  assert.equal(modelCalls, 1)
  assert.equal(loopCalls, 0)
  assert.equal(result.trace.toolCalls.length, 1)
  assert.equal(result.trace.toolCalls[0].toolName, 'check_availability')
  assert.match(result.step.reply ?? '', /可以安排/)
})

test('compose step keeps workflow tasks on deterministic tool arguments instead of LLM guesses', async () => {
  let modelCalls = 0
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('明天下午提醒我确认尺码'),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    modelFn: async () => {
      modelCalls += 1
      return '{"action":"schedule_followup","reply":"好的。","toolName":"schedule_followup","toolArgs":{"productId":"SUIT-001","reminderTime":"2025-04-15T14:00:00","reminderMessage":"确认尺码"}}'
    },
  })

  assert.equal(modelCalls, 0)
  assert.equal(result.trace.task.kind, 'follow_up')
  assert.equal(result.trace.action.toolName, 'schedule_followup')
  assert.equal(result.trace.action.toolArgs?.conversationId, 'c:SUIT-001')
  assert.equal(result.trace.action.toolArgs?.reason, '明天下午提醒我确认尺码')
  assert.notEqual(result.trace.action.toolArgs?.dueAt, '2025-04-15T14:00:00')
  assert.equal(result.trace.toolCalls[0].toolName, 'schedule_followup')
})

// ---- B3 有界搜索循环（docs/archive/agentic-search-design.md §4）----

/** 造一个可数命中次数的知识检索 fake，配合 createDefaultToolRegistry 注册 search_knowledge。 */
function knowledgeSearcher(hits: Array<{ text: string; section: string }>) {
  const state = { calls: 0, queries: [] as string[] }
  return {
    state,
    search(query: string) {
      state.calls += 1
      state.queries.push(query)
      return hits
    },
  }
}

test('搜索循环：先搜后答，搜索调用落 trace toolCalls 与 knowledge fragment', async () => {
  const searcher = knowledgeSearcher([{ text: '押金按订单规则确认', section: '租赁规则 › 押金' }])
  const seenMessages: CustomerServiceLoopMessage[][] = []
  const toolLoopFn: CustomerServiceToolLoopFn = async (messages, tools) => {
    seenMessages.push([...messages])
    if (seenMessages.length === 1) {
      assert.equal(tools.length, 1)
      assert.equal(tools[0].name, 'search_knowledge')
      return { toolCalls: [{ id: 'c1', name: 'search_knowledge', arguments: '{"query":"押金"}' }] }
    }
    return { text: '{"action":"answer_question","reply":"押金需按具体订单确认。"}' }
  }
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('租衣服要押金吗'),
    memory: memory(),
    registry: createDefaultToolRegistry(searcher),
    toolLoopFn,
  })

  assert.equal(result.step.reply, '押金需按具体订单确认。')
  assert.deepEqual(searcher.state.queries, ['押金'])
  // 搜索调用出现在 trace 的 toolCalls（step 与 trace 一致）
  assert.equal(result.trace.toolCalls.length, 1)
  assert.equal(result.trace.toolCalls[0].toolName, 'search_knowledge')
  assert.deepEqual(result.trace.toolCalls[0].arguments, { query: '押金' })
  assert.deepEqual(result.step.toolCalls, result.trace.toolCalls)
  // 结果作为 kind:'knowledge' fragment 进入 context（route 将其持久化为 references）
  const knowledge = result.trace.context.fragments.filter((f) => f.kind === 'knowledge')
  assert.equal(knowledge.length, 1)
  assert.ok(knowledge[0].content.includes('押金按订单规则确认'))
  // 第二轮模型调用能看到 role:'tool' 的检索结果回填
  const toolMessages = seenMessages[1].filter((m) => m.role === 'tool')
  assert.equal(toolMessages.length, 1)
  assert.ok(toolMessages[0].content.includes('押金按订单规则确认'))
})

test('搜索循环：商品尺码问题会把泛词 query 收敛到当前 productId 的尺码事实', async () => {
  const searcher = knowledgeSearcher([
    { text: 'SUIT-001 身高 175-181 体重 66-80 建议 L', section: 'SUIT-001 尺码参考' },
  ])
  let rounds = 0
  const toolLoopFn: CustomerServiceToolLoopFn = async () => {
    rounds += 1
    if (rounds === 1) {
      return {
        toolCalls: [
          { id: 'c1', name: 'search_knowledge', arguments: '{"query":"尺码推荐"}' },
          { id: 'c2', name: 'search_knowledge', arguments: '{"query":"尺码表"}' },
        ],
      }
    }
    return { text: '{"action":"answer_question","reply":"您这个身高体重建议 L 码。"}' }
  }
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('我 178cm 72kg，这套建议什么码？'),
    memory: memory(),
    registry: createDefaultToolRegistry(searcher),
    toolLoopFn,
  })

  assert.deepEqual(searcher.state.queries, ['SUIT-001 尺码'])
  assert.equal(result.trace.toolCalls.length, 1)
  assert.deepEqual(result.trace.toolCalls[0].arguments, { query: 'SUIT-001 尺码' })
  assert.match(result.step.reply ?? '', /L 码/)
})

test('搜索循环：达上限后工具被禁用并注入收尾指令，仍强制产出 action JSON', async () => {
  const searcher = knowledgeSearcher([{ text: '第一天全价', section: '租赁规则 › 计费' }])
  const seenToolCounts: number[] = []
  let sawWrapUp = false
  const toolLoopFn: CustomerServiceToolLoopFn = async (messages, tools) => {
    seenToolCounts.push(tools.length)
    if (tools.length > 0) {
      return {
        toolCalls: [
          {
            id: `c${seenToolCounts.length}`,
            name: 'search_knowledge',
            arguments: `{"query":"计费${seenToolCounts.length}"}`,
          },
        ],
      }
    }
    sawWrapUp = messages.some(
      (m) => m.role === 'user' && m.content.includes('知识库搜索次数已用完'),
    )
    return { text: '{"action":"answer_question","reply":"到顶后直接作答。"}' }
  }
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('租金怎么算'),
    memory: memory(),
    registry: createDefaultToolRegistry(searcher),
    toolLoopFn,
  })

  // 恰好 MAX_SEARCH_CALLS 轮带工具 + 1 轮无工具收尾
  assert.deepEqual(seenToolCounts, [1, 1, 1, 0])
  assert.equal(searcher.state.calls, MAX_SEARCH_CALLS)
  assert.ok(sawWrapUp)
  assert.equal(result.step.reply, '到顶后直接作答。')
  assert.equal(result.trace.toolCalls.length, MAX_SEARCH_CALLS)
})

test('搜索循环：坏 tool_calls 参数收到重试文案且计入轮数，不触发检索', async () => {
  const searcher = knowledgeSearcher([{ text: '不会用到', section: '无' }])
  let rounds = 0
  let badArgsReplies: string[] = []
  const toolLoopFn: CustomerServiceToolLoopFn = async (messages, tools) => {
    if (tools.length > 0) {
      rounds += 1
      // query 缺失（错误键名）——每轮都给坏参数
      return {
        toolCalls: [{ id: `b${rounds}`, name: 'search_knowledge', arguments: '{"q":"押金"}' }],
      }
    }
    // 收尾轮：从消息流收集全部 role:'tool' 回填，验证重试文案与计轮
    badArgsReplies = messages.flatMap((m) => (m.role === 'tool' ? [m.content] : []))
    return { text: '{"action":"answer_question","reply":"参数一直不对，只能直接回答。"}' }
  }
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('租衣服要押金吗'),
    memory: memory(),
    registry: createDefaultToolRegistry(searcher),
    toolLoopFn,
  })

  // 坏参数从未触发真实检索，但每次都计轮：MAX_SEARCH_CALLS 次后循环收尾
  assert.equal(searcher.state.calls, 0)
  assert.equal(badArgsReplies.length, MAX_SEARCH_CALLS)
  for (const reply of badArgsReplies) {
    assert.ok(reply.includes('query 参数缺失或不是字符串'))
  }
  assert.equal(result.step.reply, '参数一直不对，只能直接回答。')
  // 未执行的搜索不进 trace 工具审计
  assert.equal(result.trace.toolCalls.length, 0)
})

test('搜索循环：任何一步抛错回退确定性 composer（无 key 不变量保持）', async () => {
  const searcher = knowledgeSearcher([])
  const result = await runCustomerServiceHarnessStep({
    event: userEvent('这款有 L 吗，5月10到12号穿'),
    memory: memory(),
    registry: createDefaultToolRegistry(searcher),
    toolLoopFn: async () => {
      throw new Error('provider down')
    },
  })

  // 与 modelFn 失败路径同构：同一输入下确定性 composer 给出 check_availability
  assert.equal(result.trace.action.action, 'check_availability')
  assert.equal(result.trace.action.toolName, 'check_availability')
})
