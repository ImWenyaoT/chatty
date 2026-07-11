import {
  ApprovalRequiredError,
  CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
  CUSTOMER_SERVICE_SDK_INSTRUCTIONS,
  PolicyDenyError,
  createCustomerServiceRunPolicy,
  executeSearchRequest,
  type CustomerServiceModelFn,
  type CustomerServiceSdkRunner,
} from '@rental/agent-core'
import {
  type ChatCompletionTelemetry,
  createAgentsSdkCustomerServiceRunner,
  createDeepSeekAgentsModelFromEnv,
  createDeepSeekAgentsSdkToolLoop,
  parseJsonObject,
  readLlmEnv,
} from '@rental/llm'
import { readQuestionFromEvent, type JsonValue, type RuntimeToolCall } from '@rental/shared'
import { z } from 'zod'

export type LlmTelemetrySummary = {
  model: string
  calls: number
  callBudget: number
  inputCacheHitTokens: number
  inputCacheMissTokens: number
  inputCacheHitRatio: number
  outputTokens: number
  totalTokens: number
  estimatedCostCny: number
  operations: Array<ChatCompletionTelemetry['operation']>
  warnings: string[]
}

type LlmRuntimeOptions = {
  callBudget?: number
}

type LlmRuntimeMode = 'disabled' | 'agents-sdk'

const DEFAULT_LLM_CALL_BUDGET = 3

export class MissingLlmApiKeyError extends Error {
  constructor() {
    super('DeepSeek API key is required')
    this.name = 'MissingLlmApiKeyError'
  }
}

const SDK_TOOL_SCHEMAS = {
  search_knowledge: z.object({ query: z.string() }).strict(),
  check_availability: z
    .object({ size: z.string(), startDate: z.string(), endDate: z.string() })
    .strict(),
  create_handoff: z.object({ reason: z.string(), context: z.string().nullable() }).strict(),
  schedule_followup: z.object({ dueAt: z.string(), reason: z.string() }).strict(),
} as const

/** Builds the single production Agents SDK runner; task policy controls each cloned Agent. */
export function createPlaygroundSdkRunner(
  records: ChatCompletionTelemetry[] = [],
): CustomerServiceSdkRunner {
  const env = readLlmEnv()
  if (!env.apiKey) throw new MissingLlmApiKeyError()
  const model = createDeepSeekAgentsModelFromEnv()

  return async (runtime) => {
    const toolCalls: RuntimeToolCall[] = []
    const toolResults: JsonValue[] = []
    const tools = runtime.runPolicy.toolNames.map((name) => {
      const capability = runtime.registry.get(name)
      if (!capability) throw new Error(`required SDK tool is not registered: ${name}`)
      return {
        name,
        description: capability.description,
        parameters: SDK_TOOL_SCHEMAS[name],
        needsApproval: capability.approvalRequired,
        execute: async (raw: unknown) => {
          const parsed = SDK_TOOL_SCHEMAS[name].parse(raw) as unknown as Record<string, JsonValue>
          const args = {
            ...parsed,
            ...(name === 'check_availability'
              ? { productId: runtime.event.productId ?? runtime.memory.productId ?? '' }
              : {}),
            ...(name === 'create_handoff' || name === 'schedule_followup'
              ? { conversationId: runtime.event.conversationId }
              : {}),
          }
          const call: RuntimeToolCall = {
            toolName: name,
            arguments: args,
            risk: capability.risk,
            approvalRequired: capability.approvalRequired,
          }
          toolCalls.push(call)
          runtime.emitEvent?.('tool_attempted', call as unknown as JsonValue)
          let result: JsonValue
          try {
            result = await runtime.registry.invokeWithPolicy(name, args, runtime.policy, {
              sessionStatus: runtime.sessionStatus,
            })
          } catch (error) {
            if (!(error instanceof ApprovalRequiredError) && !(error instanceof PolicyDenyError)) {
              throw error
            }
            result = { error: error.name, message: error.message }
          }
          toolResults.push(result)
          runtime.emitEvent?.('tool_completed', { toolName: name, result })
          if (name === 'search_knowledge' && result && typeof result === 'object') {
            const output = (result as { output?: unknown }).output
            if (typeof output === 'string') {
              runtime.context.fragments.push({
                kind: 'knowledge',
                label: '知识库工具结果',
                content: output,
              })
            }
          }
          return result
        },
      }
    })
    const runSdk = createAgentsSdkCustomerServiceRunner({
      instructions: CUSTOMER_SERVICE_SDK_INSTRUCTIONS,
      input: buildSdkPrompt(runtime),
      model,
      modelName: env.chatModel,
      tools,
      toolChoice: runtime.runPolicy.toolChoice,
      toolUseBehavior: runtime.runPolicy.toolUseBehavior,
      maxTurns: runtime.runPolicy.maxTurns,
      telemetry: (record) => records.push(record),
      signal: runtime.signal,
    })
    runtime.emitEvent?.('model_called', { model: env.chatModel })
    const output = await runSdk()
    return {
      reply: output.reply,
      action: {
        action: actionForTask(runtime.task.kind),
        reply: output.reply,
        toolName: toolCalls[0]?.toolName,
        toolArgs: toolCalls[0]?.arguments,
      },
      toolCalls,
      toolResults,
      outputValidated: true,
    }
  }
}

/** Renders task, tool policy, and dynamic context in a cache-friendly stable order. */
function buildSdkPrompt(runtime: Parameters<CustomerServiceSdkRunner>[0]): string {
  const [task, ...dynamicFragments] = runtime.context.fragments
  const render = (fragment: (typeof runtime.context.fragments)[number]) =>
    `## ${fragment.label}\n${fragment.content}`
  return [
    task ? render(task) : '',
    `## 当前工具策略\n允许工具：${runtime.runPolicy.toolNames.join(', ') || '无'}\n工具选择：${runtime.runPolicy.toolChoice}`,
    ...dynamicFragments.map(render),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Derives the auditable action summary from the deterministic scheduled task. */
function actionForTask(kind: Parameters<typeof createCustomerServiceRunPolicy>[0]['kind']) {
  if (kind === 'collect_missing_info') return 'ask_missing_info' as const
  if (kind === 'answer_question') return 'answer_question' as const
  if (kind === 'check_availability') return 'check_availability' as const
  if (kind === 'handoff') return 'handoff' as const
  return 'schedule_followup' as const
}

/** Calculates the normalized prompt/KV cache hit ratio for input tokens. */
function calculateInputCacheHitRatio(hitTokens: number, missTokens: number): number {
  const totalInputTokens = hitTokens + missTokens
  if (totalInputTokens <= 0) return 0
  return Number((hitTokens / totalInputTokens).toFixed(4))
}

/**
 * Builds the live LLM compose call for the playground harness step.
 *
 * Builds the live DeepSeek compose call for the playground harness step.
 *
 * DeepSeek is enabled whenever an API key is present; otherwise the harness
 * runs the deterministic composer and keeps no-key demo/smoke behavior.
 */
export function createPlaygroundModelFn(): CustomerServiceModelFn | undefined {
  if (!readLlmEnv().apiKey) return undefined
  return createAgentsSdkComposeModelFn()
}

/** Wraps the Agents SDK run loop into the existing harness modelFn contract. */
function createAgentsSdkComposeModelFn(
  records: ChatCompletionTelemetry[] = [],
): CustomerServiceModelFn {
  return async (prompt, runtime) => {
    const searchTool =
      runtime?.task.kind === 'answer_question'
        ? runtime.registry?.get('search_knowledge')
        : undefined
    const runSdk = createDeepSeekAgentsSdkToolLoop({
      instructions: CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
      maxTurns: searchTool ? 4 : 2,
      telemetry: (record) => records.push(record),
      tools:
        runtime && searchTool
          ? [
              {
                name: searchTool.name,
                description: searchTool.description,
                parameters: searchTool.parameters ?? { type: 'object', properties: {} },
                needsApproval: searchTool.approvalRequired,
                execute: async (input) => executeSdkSearchTool(input, runtime, searchTool.name),
              },
            ]
          : [],
    })
    const raw = await runSdk(prompt)
    return JSON.stringify(parseJsonObject<Record<string, unknown>>(raw))
  }
}

/**
 * Executes search_knowledge from an Agents SDK function tool while preserving
 * the harness-owned policy gate, knowledge references, and auditable trace.
 */
async function executeSdkSearchTool(
  input: unknown,
  runtime: NonNullable<Parameters<CustomerServiceModelFn>[1]>,
  toolName: string,
): Promise<string> {
  const registry = runtime.registry
  if (!registry)
    return '工具注册表不可用。请基于已知信息谨慎回答，不确定的内容如实告知用户无法确认。'

  const result = await executeSearchRequest({
    toolName,
    input,
    registry,
    question: readQuestionFromEvent(runtime.event),
    productId: runtime.event.productId ?? runtime.memory.productId,
    searchedQueries:
      runtime.searchTrace?.toolCalls.flatMap((call) =>
        typeof call.arguments.query === 'string' ? [call.arguments.query] : [],
      ) ?? [],
    sessionStatus: runtime.sessionStatus,
    policy: runtime.policy,
  })
  if (result.kind === 'retry') return result.output
  runtime.context.fragments.push(result.fragment)
  runtime.searchTrace?.toolCalls.push(result.toolCall)
  runtime.searchTrace?.toolResults.push(result.toolResult)
  return result.output
}

/** Aggregates per-call LLM telemetry into a compact trace payload for the playground inspector. */
export function createLlmTelemetrySummary(
  model: string,
  records: ChatCompletionTelemetry[],
  options: LlmRuntimeOptions = {},
): LlmTelemetrySummary {
  const callBudget = options.callBudget ?? DEFAULT_LLM_CALL_BUDGET
  const summary = records.reduce<Omit<LlmTelemetrySummary, 'inputCacheHitRatio' | 'warnings'>>(
    (summary, record) => ({
      model,
      calls: summary.calls + 1,
      callBudget,
      inputCacheHitTokens: summary.inputCacheHitTokens + record.inputCacheHitTokens,
      inputCacheMissTokens: summary.inputCacheMissTokens + record.inputCacheMissTokens,
      outputTokens: summary.outputTokens + record.outputTokens,
      totalTokens: summary.totalTokens + record.totalTokens,
      estimatedCostCny: Number((summary.estimatedCostCny + record.estimatedCostCny).toFixed(12)),
      operations: [...summary.operations, record.operation],
    }),
    {
      model,
      calls: 0,
      callBudget,
      inputCacheHitTokens: 0,
      inputCacheMissTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostCny: 0,
      operations: [],
    },
  )
  const warnings =
    summary.calls > callBudget ? [`llm_call_budget_exceeded: ${summary.calls}/${callBudget}`] : []
  return {
    ...summary,
    inputCacheHitRatio: calculateInputCacheHitRatio(
      summary.inputCacheHitTokens,
      summary.inputCacheMissTokens,
    ),
    warnings,
  }
}

/**
 * Builds the playground LLM hooks as one per-request runtime. The live Agents
 * SDK compose modelFn feeds the shared pro-model telemetry collector (per-call
 * KV cache hit/miss + cost); the direct tool-loop lane is retired, so
 * toolLoopFn is always undefined.
 */
export function createPlaygroundLlmRuntime(options: LlmRuntimeOptions = {}): {
  mode: LlmRuntimeMode
  sdkRunner: CustomerServiceSdkRunner
  summary: () => LlmTelemetrySummary
} {
  const env = readLlmEnv()
  const records: ChatCompletionTelemetry[] = []
  const callBudget = options.callBudget ?? DEFAULT_LLM_CALL_BUDGET
  if (!env.apiKey) {
    throw new MissingLlmApiKeyError()
  }
  return {
    mode: 'agents-sdk',
    sdkRunner: createPlaygroundSdkRunner(records),
    summary: () => createLlmTelemetrySummary(env.chatModel, records, { callBudget }),
  }
}
