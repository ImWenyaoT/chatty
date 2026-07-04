import type {
  AgentSessionStatus,
  AgentStepResult,
  AgentStepTerminality,
  ConversationEvent,
  JsonValue,
  MemorySnapshot,
  RuntimeTool,
  RuntimeToolCall,
  RuntimeToolRisk,
} from '@rental/shared'
import { readQuestionFromEvent } from '@rental/shared'
import { createDefaultPolicy, type Policy } from './policies/policy.js'
import type { ToolRegistry } from './tools/registry.js'
import { ApprovalRequiredError, PolicyDenyError } from './tools/registry.js'

export type CustomerServiceTaskKind =
  | 'collect_missing_info'
  | 'answer_question'
  | 'check_availability'
  | 'handoff'
  | 'follow_up'

export type CustomerServiceActionKind =
  | 'ask_missing_info'
  | 'answer_question'
  | 'check_availability'
  | 'recommend_size'
  | 'handoff'
  | 'schedule_followup'

export interface CustomerServiceTask {
  kind: CustomerServiceTaskKind
  goal: string
  terminality: AgentStepTerminality
  requiredContext: string[]
  risk: RuntimeToolRisk
}

export interface CustomerServiceContextFragment {
  kind: 'task' | 'user_message' | 'memory' | 'product' | 'order' | 'knowledge'
  label: string
  content: string
}

export interface CustomerServiceContext {
  fragments: CustomerServiceContextFragment[]
  prompt: string
}

export interface CustomerServiceAction {
  action: CustomerServiceActionKind
  reply: string
  toolName?: string
  toolArgs?: Record<string, JsonValue>
}

export interface CustomerServiceTrace {
  traceId: string
  task: CustomerServiceTask
  context: CustomerServiceContext
  action: CustomerServiceAction
  toolCalls: RuntimeToolCall[]
  toolResults: JsonValue[]
}

export interface CustomerServiceHarnessStepResult {
  step: AgentStepResult
  trace: CustomerServiceTrace
}

export interface CustomerServiceTurnInput {
  event: ConversationEvent
  memory: MemorySnapshot
}

export interface CreateCustomerServiceModelOutputInput extends CustomerServiceTurnInput {
  task: CustomerServiceTask
}

/**
 * Injectable model call for the compose step: takes the harness-built context
 * prompt and returns the raw model reply text. Kept as a plain function so the
 * harness stays testable without any LLM package or network access.
 */
export type CustomerServiceModelFn = (prompt: string) => Promise<string>

/** 模型发起的一次工具调用；arguments 为原始 JSON 字符串（结构对齐 @rental/llm）。 */
export type CustomerServiceLoopToolCall = { id: string; name: string; arguments: string }

/** 循环内暴露给模型的工具定义（Chat Completions function 形态）。 */
export interface CustomerServiceToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 工具循环消息：三角色之上扩展 assistant 携带 toolCalls 与 role:'tool' 回填。 */
export type CustomerServiceLoopMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; toolCalls: CustomerServiceLoopToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

/** 有界循环的每轮模型调用（§4.1 C2）：apps/web 用 completeWithTools 实现注入。 */
export type CustomerServiceToolLoopFn = (
  messages: CustomerServiceLoopMessage[],
  tools: CustomerServiceToolDefinition[],
) => Promise<{ toolCalls: CustomerServiceLoopToolCall[] } | { text: string }>

/** 单轮 compose 内 search_knowledge 的调用上限（§4.2 M2）：硬编码，不做配置项。 */
export const MAX_SEARCH_CALLS = 3
// 达上限收尾指令（§4.2，兼作超额并行调用的回填）与坏参数重试提示（§4.3 层 2）
const SEARCH_BUDGET_EXHAUSTED = '知识库搜索次数已用完。基于以上搜索结果，直接输出 action JSON。'
const SEARCH_BAD_ARGS = 'query 参数缺失或不是字符串，请重试，只需提供 query 一个参数'

export interface ComposeCustomerServiceModelOutputInput
  extends CreateCustomerServiceModelOutputInput {
  context: CustomerServiceContext
  modelFn?: CustomerServiceModelFn
  toolLoopFn?: CustomerServiceToolLoopFn
  registry?: ToolRegistry
  sessionStatus?: AgentSessionStatus
  policy?: Policy
  /** 循环中实际执行的搜索调用记录，供 harness 落 trace（红线 3：搜索必须可审计）。 */
  searchTrace?: { toolCalls: RuntimeToolCall[]; toolResults: JsonValue[] }
}

export interface ExecuteCustomerServiceActionInput {
  action: CustomerServiceAction
  registry: ToolRegistry
  sessionStatus?: AgentSessionStatus
  policy?: Policy
}

export interface RunCustomerServiceHarnessStepInput extends CustomerServiceTurnInput {
  registry: ToolRegistry
  /** Pre-composed model output; when provided the compose step is skipped. */
  modelOutput?: string
  /** Optional LLM compose call; absent => deterministic composer. */
  modelFn?: CustomerServiceModelFn
  /** Optional LLM tool-loop call; present (with search_knowledge) => bounded search loop. */
  toolLoopFn?: CustomerServiceToolLoopFn
  sessionStatus?: AgentSessionStatus
  policy?: Policy
}

/**
 * System instructions for the LLM compose path. Constrains the model to emit
 * exactly the action JSON parseCustomerServiceOutput accepts; whatever the
 * model asks for, tool execution still passes the executor's policy gate.
 */
export const CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS = [
  '你是租赁电商的客服助手。根据给定的任务和上下文，只输出一个 JSON 对象（不要 markdown 代码块、不要解释文字）：',
  '{"action": "...", "reply": "...", "toolName": "...", "toolArgs": {...}}',
  'action 必须是以下之一：ask_missing_info / answer_question / check_availability / recommend_size / handoff / schedule_followup。',
  'reply 是发给用户的中文回复。toolName/toolArgs 可选，仅在需要查库存（check_availability）、转人工（create_handoff）或安排跟进（schedule_followup）时给出。',
  // §4.3 系统级增补：Mandatory recall + 诚实条款 + 对客不暴露内部出处
  '回答政策、费用、售后类事实问题前，先调用 search_knowledge 搜索知识库；搜索后仍不确定的内容，如实告诉用户需要进一步确认，不要编造。',
  '回复中不要向用户提及知识库、搜索过程或文档出处，用自己的话自然表述。',
].join('\n')

/**
 * Schedules the next bounded customer-service task from the current user turn.
 * This is intentionally deterministic: the LLM may decide wording and action
 * details later, but the harness owns workflow shape and safety posture.
 */
export function scheduleCustomerServiceTask(input: CustomerServiceTurnInput): CustomerServiceTask {
  const question = readQuestionFromEvent(input.event).toLowerCase()
  if (mentionsHandoff(question)) {
    return {
      kind: 'handoff',
      goal: '转人工处理投诉、退款或超出自动处理边界的问题',
      terminality: 'handoff_and_wait',
      requiredContext: ['conversationId', 'handoffReason'],
      risk: 'medium',
    }
  }
  if (mentionsFollowUp(question)) {
    return {
      kind: 'follow_up',
      goal: '安排后续提醒或售后跟进',
      terminality: 'schedule_and_wait',
      requiredContext: ['conversationId', 'dueAt', 'reason'],
      risk: 'low',
    }
  }
  if (hasRentalPeriod(question) && hasBodyOrSize(question) && input.event.productId) {
    return {
      kind: 'check_availability',
      goal: '基于商品、档期和尺码信息检查库存可用性',
      terminality: 'tool_then_continue',
      requiredContext: ['productId', 'rentalPeriod', 'bodyMeasurements'],
      risk: 'low',
    }
  }
  if (!input.event.productId || !hasEnoughRentalContext(question, input.memory)) {
    return {
      kind: 'collect_missing_info',
      goal: '收集客服履约所需的商品、档期、身高体重或数量信息',
      terminality: 'reply_and_wait',
      requiredContext: ['productId', 'rentalPeriod', 'bodyMeasurements'],
      risk: 'low',
    }
  }
  return {
    kind: 'answer_question',
    goal: '回答当前客服问题，并保持下一步流程清晰',
    terminality: 'reply_and_wait',
    requiredContext: ['userMessage', 'recentMessages'],
    risk: 'low',
  }
}

/**
 * Builds an ordered, inspectable customer-service prompt context. The same
 * fragments can be rendered in a GUI so users see exactly what shaped a reply.
 */
export function buildCustomerServiceContext(
  input: CustomerServiceTurnInput & {
    task: CustomerServiceTask
  },
): CustomerServiceContext {
  const fragments: CustomerServiceContextFragment[] = [
    {
      kind: 'task',
      label: '当前客服任务',
      content: `${input.task.kind}: ${input.task.goal}`,
    },
    {
      kind: 'user_message',
      label: '用户本轮消息',
      content: readQuestionFromEvent(input.event),
    },
  ]

  if (
    input.memory.recentMessages.length > 0 ||
    input.memory.customerMemory ||
    input.memory.productMemory
  ) {
    fragments.push({
      kind: 'memory',
      label: '记忆与最近对话',
      content: JSON.stringify(
        {
          recentMessages: input.memory.recentMessages,
          customerMemory: input.memory.customerMemory ?? null,
          productMemory: input.memory.productMemory ?? null,
        },
        null,
        2,
      ),
    })
  }

  if (input.event.productId) {
    fragments.push({
      kind: 'product',
      label: '商品上下文',
      content: `productId=${input.event.productId}`,
    })
  }

  const prompt = fragments
    .map((fragment) => `## ${fragment.label}\n${fragment.content}`)
    .join('\n\n')
  return { fragments, prompt }
}

/**
 * Parses model output into a constrained customer-service action. Invalid or
 * over-freeform output falls back to a safe answer action instead of controlling
 * tools directly.
 */
export function parseCustomerServiceOutput(raw: string): CustomerServiceAction {
  try {
    const parsed = JSON.parse(raw) as Partial<CustomerServiceAction>
    if (!isCustomerServiceActionKind(parsed.action) || typeof parsed.reply !== 'string') {
      return fallbackAction()
    }
    return {
      action: parsed.action,
      reply: parsed.reply,
      toolName: typeof parsed.toolName === 'string' ? parsed.toolName : undefined,
      toolArgs: isPlainJsonObject(parsed.toolArgs) ? parsed.toolArgs : undefined,
    }
  } catch {
    return fallbackAction()
  }
}

/**
 * Creates a constrained action JSON string from a scheduled customer-service
 * task. This is the deterministic composer: the default when no modelFn is
 * injected, and the fallback when the injected LLM call fails.
 */
export function createCustomerServiceModelOutput(
  input: CreateCustomerServiceModelOutputInput,
): string {
  const question = readQuestionFromEvent(input.event)
  const productId = input.event.productId ?? input.memory.productId ?? 'general'
  const action = actionForTask(input.task, question, productId, input.event.conversationId)
  return JSON.stringify(action)
}

/**
 * Compose step: toolLoopFn（配 search_knowledge）时走有界搜索循环（§4），仅
 * modelFn 时单发写 action JSON；两者缺席、失败或空回复一律落回确定性 composer，
 * 无 API key 也必有回复。
 */
export async function composeCustomerServiceModelOutput(
  input: ComposeCustomerServiceModelOutputInput,
): Promise<string> {
  const { toolLoopFn, modelFn } = input
  const searchTool = toolLoopFn && input.registry?.get('search_knowledge')
  const callModel =
    toolLoopFn && searchTool
      ? () => runComposeSearchLoop(input, toolLoopFn, searchTool)
      : modelFn && (() => modelFn(input.context.prompt))
  if (callModel) {
    try {
      const output = await callModel()
      if (output.trim().length > 0) return output
    } catch {
      // 单发或循环任一步失败（§4.3 层 3）：统一落回下方确定性 composer
    }
  }
  return createCustomerServiceModelOutput(input)
}

/**
 * §4 有界搜索循环：至多 MAX_SEARCH_CALLS 个搜索轮 + 1 个无工具收尾轮。坏参数
 * 重试同样计轮（防刷）；超出上限的并行调用不执行，以收尾文案回填（协议要求每个
 * call 有回应）。达上限后清空工具列表并注入收尾指令，强制直接输出 action JSON；
 * 仍不收敛则抛错，由 compose 落回确定性 composer。
 */
async function runComposeSearchLoop(
  input: ComposeCustomerServiceModelOutputInput,
  toolLoopFn: CustomerServiceToolLoopFn,
  searchTool: RuntimeTool,
): Promise<string> {
  const { name, description, parameters = { type: 'object', properties: {} } } = searchTool
  const tools: CustomerServiceToolDefinition[] = [{ name, description, parameters }]
  const messages: CustomerServiceLoopMessage[] = [
    { role: 'system', content: CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS },
    { role: 'user', content: input.context.prompt },
  ]
  let rounds = 0
  for (let turn = 0; turn <= MAX_SEARCH_CALLS; turn += 1) {
    const reply = await toolLoopFn(messages, rounds >= MAX_SEARCH_CALLS ? [] : tools)
    if ('text' in reply) return reply.text
    messages.push({ role: 'assistant', content: '', toolCalls: reply.toolCalls })
    for (const call of reply.toolCalls) {
      rounds += 1
      const content =
        rounds > MAX_SEARCH_CALLS ? SEARCH_BUDGET_EXHAUSTED : await runSearchCall(input, call)
      messages.push({ role: 'tool', toolCallId: call.id, content })
    }
    if (rounds >= MAX_SEARCH_CALLS) {
      messages.push({ role: 'user', content: SEARCH_BUDGET_EXHAUSTED })
    }
  }
  throw new Error('compose search loop did not converge to a text reply')
}

/** 循环内单次搜索：坏参数回重试提示（不触发检索）；否则过 policy 门执行，结果落 fragment 与 searchTrace。 */
async function runSearchCall(
  input: ComposeCustomerServiceModelOutputInput,
  call: CustomerServiceLoopToolCall,
): Promise<string> {
  let query: unknown
  try {
    query = (JSON.parse(call.arguments) as Record<string, unknown>).query
  } catch {}
  if (call.name !== 'search_knowledge' || typeof query !== 'string' || query.trim().length === 0) {
    return SEARCH_BAD_ARGS
  }
  const result = await (input.registry as ToolRegistry).invokeWithPolicy(
    call.name,
    { query },
    input.policy ?? createDefaultPolicy(),
    { sessionStatus: input.sessionStatus ?? 'active' },
  )
  const output =
    isPlainJsonObject(result) && typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result)
  input.context.fragments.push({
    kind: 'knowledge',
    label: `知识库检索：${query}`,
    content: output,
  })
  input.searchTrace?.toolCalls.push({
    toolName: call.name,
    arguments: { query },
    risk: 'low',
    approvalRequired: false,
  })
  input.searchTrace?.toolResults.push(result)
  return output
}

/**
 * Executes a parsed customer-service action through the existing tool registry
 * and policy gate. The executor returns loop terminality, tool calls, tool
 * results, and status without running hidden side effects.
 */
export async function executeCustomerServiceAction(
  input: ExecuteCustomerServiceActionInput,
): Promise<{
  terminality: AgentStepTerminality
  nextStatus: AgentSessionStatus
  toolCalls: RuntimeToolCall[]
  toolResults: JsonValue[]
}> {
  if (!input.action.toolName) {
    return terminalityForAction(input.action.action)
  }

  const tool = input.registry.get(input.action.toolName)
  const args = input.action.toolArgs ?? {}
  if (!tool) {
    return {
      terminality: 'handoff_and_wait',
      nextStatus: 'waiting_for_human',
      toolCalls: [],
      toolResults: [{ error: 'tool_not_found', toolName: input.action.toolName }],
    }
  }

  const call: RuntimeToolCall = {
    toolName: tool.name,
    arguments: args,
    risk: tool.risk,
    approvalRequired: tool.approvalRequired,
  }

  try {
    const result = await input.registry.invokeWithPolicy(
      tool.name,
      args,
      input.policy ?? createDefaultPolicy(),
      { sessionStatus: input.sessionStatus ?? 'active' },
    )
    return {
      terminality: 'tool_then_continue',
      nextStatus: 'waiting_for_user',
      toolCalls: [call],
      toolResults: [result],
    }
  } catch (error) {
    if (error instanceof ApprovalRequiredError || error instanceof PolicyDenyError) {
      return {
        terminality: 'handoff_and_wait',
        nextStatus: 'waiting_for_human',
        toolCalls: [],
        toolResults: [{ error: error.name, message: error.message }],
      }
    }
    throw error
  }
}

/**
 * Runs one bounded customer-service harness step: schedule task, build context,
 * compose model output (injected LLM or deterministic fallback), parse it,
 * execute allowed tools, and return an inspectable trace.
 */
export async function runCustomerServiceHarnessStep(
  input: RunCustomerServiceHarnessStepInput,
): Promise<CustomerServiceHarnessStepResult> {
  const task = scheduleCustomerServiceTask(input)
  const context = buildCustomerServiceContext({ ...input, task })
  // 搜索循环调用记录收集器（无 toolLoopFn 时恒空）；搜索在前、动作工具在后合成审计记录
  const searchTrace = { toolCalls: [] as RuntimeToolCall[], toolResults: [] as JsonValue[] }
  const modelOutput =
    input.modelOutput ??
    (await composeCustomerServiceModelOutput({ ...input, task, context, searchTrace }))
  const action = parseCustomerServiceOutput(modelOutput)
  const executed = await executeCustomerServiceAction({
    action,
    registry: input.registry,
    sessionStatus: input.sessionStatus,
    policy: input.policy,
  })
  const traceId = input.event.traceId ?? input.event.eventId
  const memoryPatch = {
    lastHarnessTask: task.kind,
    lastHarnessAction: action.action,
  } as unknown as JsonValue

  const toolCalls = [...searchTrace.toolCalls, ...executed.toolCalls]
  return {
    step: {
      sessionId: input.event.conversationId,
      traceId,
      terminality: executed.terminality,
      reply: action.reply,
      toolCalls,
      nextStatus: executed.nextStatus,
      memoryPatch,
    },
    trace: {
      traceId,
      task,
      context,
      action,
      toolCalls,
      toolResults: [...searchTrace.toolResults, ...executed.toolResults],
    },
  }
}

function terminalityForAction(action: CustomerServiceActionKind): {
  terminality: AgentStepTerminality
  nextStatus: AgentSessionStatus
  toolCalls: RuntimeToolCall[]
  toolResults: JsonValue[]
} {
  if (action === 'handoff') {
    return {
      terminality: 'handoff_and_wait',
      nextStatus: 'waiting_for_human',
      toolCalls: [],
      toolResults: [],
    }
  }
  if (action === 'schedule_followup') {
    return {
      terminality: 'schedule_and_wait',
      nextStatus: 'waiting_for_user',
      toolCalls: [],
      toolResults: [],
    }
  }
  return {
    terminality: 'reply_and_wait',
    nextStatus: 'waiting_for_user',
    toolCalls: [],
    toolResults: [],
  }
}

function fallbackAction(): CustomerServiceAction {
  return {
    action: 'answer_question',
    reply: '我先帮您确认一下，再继续处理。',
  }
}

function actionForTask(
  task: CustomerServiceTask,
  question: string,
  productId: string,
  conversationId: string,
): CustomerServiceAction {
  switch (task.kind) {
    case 'check_availability':
      return {
        action: 'check_availability',
        reply: '我先帮您查一下这个尺码和档期是否能安排。',
        toolName: 'check_availability',
        toolArgs: { productId, size: extractSize(question) },
      }
    case 'handoff':
      return {
        action: 'handoff',
        reply: '好的，这个问题我帮您转接人工客服继续处理。',
        toolName: 'create_handoff',
        toolArgs: { conversationId, reason: question.slice(0, 80) || '用户请求人工处理' },
      }
    case 'follow_up':
      return {
        action: 'schedule_followup',
        reply: '好的，我先把后续跟进事项记下来。',
        toolName: 'schedule_followup',
        toolArgs: { conversationId, dueAt: 'next_business_day', reason: question.slice(0, 80) },
      }
    case 'collect_missing_info':
      return {
        action: 'ask_missing_info',
        reply: '您把想租的款式、使用日期、身高体重发我，我这边继续帮您对尺码和档期。',
      }
    case 'answer_question':
    default:
      return {
        action: 'answer_question',
        reply: '收到，我先结合当前商品和会话信息帮您确认。',
      }
  }
}

function extractSize(question: string): string {
  const match = question.toUpperCase().match(/\b(XXL|XL|L|M|S)\b/)
  return match?.[1] ?? 'L'
}

function mentionsHandoff(question: string): boolean {
  return /投诉|退款|人工|客服|赔偿|差评/.test(question)
}

function mentionsFollowUp(question: string): boolean {
  return /提醒|跟进|到期|明天|后天|稍后/.test(question)
}

function hasRentalPeriod(question: string): boolean {
  return /\d+\s*月|\d+[/-]\d+|到|至|号|日/.test(question)
}

function hasBodyOrSize(question: string): boolean {
  return /身高|体重|kg|公斤|斤|[smlxl]{1,3}\b|码/.test(question)
}

function hasEnoughRentalContext(question: string, memory: MemorySnapshot): boolean {
  return hasRentalPeriod(question) || hasBodyOrSize(question) || memory.recentMessages.length > 0
}

function isCustomerServiceActionKind(value: unknown): value is CustomerServiceActionKind {
  return (
    value === 'ask_missing_info' ||
    value === 'answer_question' ||
    value === 'check_availability' ||
    value === 'recommend_size' ||
    value === 'handoff' ||
    value === 'schedule_followup'
  )
}

function isPlainJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
