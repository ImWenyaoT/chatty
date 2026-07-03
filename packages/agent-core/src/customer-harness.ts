import type {
  AgentSessionStatus,
  AgentStepResult,
  AgentStepTerminality,
  ConversationEvent,
  JsonValue,
  MemorySnapshot,
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
  kind: 'task' | 'user_message' | 'memory' | 'product' | 'order'
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

export interface ExecuteCustomerServiceActionInput {
  action: CustomerServiceAction
  registry: ToolRegistry
  sessionStatus?: AgentSessionStatus
  policy?: Policy
}

export interface RunCustomerServiceHarnessStepInput extends CustomerServiceTurnInput {
  registry: ToolRegistry
  modelOutput: string
  sessionStatus?: AgentSessionStatus
  policy?: Policy
}

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
 * task. This keeps the playground path deterministic while the harness shape is
 * being proven; a later LLM adapter can replace only this composer.
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
 * parse model output, execute allowed tools, and return an inspectable trace.
 */
export async function runCustomerServiceHarnessStep(
  input: RunCustomerServiceHarnessStepInput,
): Promise<CustomerServiceHarnessStepResult> {
  const task = scheduleCustomerServiceTask(input)
  const context = buildCustomerServiceContext({ ...input, task })
  const action = parseCustomerServiceOutput(input.modelOutput)
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

  return {
    step: {
      sessionId: input.event.conversationId,
      traceId,
      terminality: executed.terminality,
      reply: action.reply,
      toolCalls: executed.toolCalls,
      nextStatus: executed.nextStatus,
      memoryPatch,
    },
    trace: {
      traceId,
      task,
      context,
      action,
      toolCalls: executed.toolCalls,
      toolResults: executed.toolResults,
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
