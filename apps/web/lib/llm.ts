import {
  CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
  createDefaultPolicy,
  type CustomerServiceModelFn,
  type CustomerServiceToolLoopFn,
} from '@rental/agent-core'
import {
  type ChatCompletionTelemetry,
  type ChatCompletionsAdapter,
  createChatCompletionsAdapterFromEnv,
  createDeepSeekAgentsSdkToolLoop,
  parseJsonObject,
  readLlmEnv,
} from '@rental/llm'

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

type LlmRuntimeMode = 'disabled' | 'chat-completions' | 'agents-sdk'

const DEFAULT_LLM_CALL_BUDGET = 3

/** True only when the developer explicitly disables live DeepSeek calls. */
function isLlmExplicitlyDisabled(): boolean {
  return process.env.CHATTY_LLM === '0'
}

/** SDK is the default live lane; this flag exists only for direct-adapter debugging. */
function isAgentsSdkExplicitlyDisabled(): boolean {
  return process.env.CHATTY_AGENTS_SDK === '0'
}

/** Calculates the normalized prompt/KV cache hit ratio for input tokens. */
function calculateInputCacheHitRatio(hitTokens: number, missTokens: number): number {
  const totalInputTokens = hitTokens + missTokens
  if (totalInputTokens <= 0) return 0
  return Number((hitTokens / totalInputTokens).toFixed(4))
}

/**
 * Wraps a Chat Completions adapter into the harness compose modelFn.
 *
 * Goes through completeJson (response_format json_object hint + tolerant
 * extraction of JSON wrapped in ```json fences or surrounding prose — common
 * with DeepSeek's OpenAI-format endpoint) instead of raw complete(),
 * then re-stringifies the parsed object so parseCustomerServiceOutput always
 * receives bare JSON. When the reply contains no parseable JSON at all,
 * completeJson throws and composeCustomerServiceModelOutput falls back to the
 * deterministic composer — never the parser's generic fallbackAction wording.
 */
export function createComposeModelFn(adapter: ChatCompletionsAdapter): CustomerServiceModelFn {
  return async (prompt) => {
    const parsed = await adapter.completeJson<Record<string, unknown>>([
      { role: 'system', content: CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS },
      { role: 'user', content: prompt },
    ])
    return JSON.stringify(parsed)
  }
}

/**
 * Builds the live LLM compose call for the playground harness step.
 *
 * Builds the live DeepSeek compose call for the playground harness step.
 *
 * DeepSeek is the default when an API key is present. Set CHATTY_LLM=0 only
 * when deterministic fallback is desired; set CHATTY_AGENTS_SDK=0 only for
 * direct Chat Completions adapter debugging.
 */
export function createPlaygroundModelFn(): CustomerServiceModelFn | undefined {
  if (isLlmExplicitlyDisabled()) return undefined
  if (!readLlmEnv().apiKey) return undefined
  if (!isAgentsSdkExplicitlyDisabled()) return createAgentsSdkComposeModelFn()
  return createComposeModelFn(createChatCompletionsAdapterFromEnv())
}

/** Wraps the Agents SDK run loop into the existing harness modelFn contract. */
function createAgentsSdkComposeModelFn(): CustomerServiceModelFn {
  return async (prompt, runtime) => {
    const searchTool =
      runtime?.task.kind === 'answer_question'
        ? runtime.registry?.get('search_knowledge')
        : undefined
    const runSdk = createDeepSeekAgentsSdkToolLoop({
      instructions: CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
      maxTurns: searchTool ? 4 : 2,
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
  const query = readSdkSearchQuery(input)
  if (!query) return 'query 参数缺失或不是字符串，请重试，只需提供 query 一个参数'

  const result = await registry.invokeWithPolicy(
    toolName,
    { query },
    runtime.policy ?? createDefaultPolicy(),
    { sessionStatus: runtime.sessionStatus ?? 'active' },
  )
  const output =
    isPlainRecord(result) && typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result)
  runtime.context.fragments.push({
    kind: 'knowledge',
    label: `知识库检索：${query}`,
    content: output,
  })
  runtime.searchTrace?.toolCalls.push({
    toolName,
    arguments: { query },
    risk: 'low',
    approvalRequired: false,
  })
  runtime.searchTrace?.toolResults.push(result)
  return output
}

/** Extracts the SDK function tool input, accepting both parsed objects and raw JSON strings. */
function readSdkSearchQuery(input: unknown): string | undefined {
  let source = input
  if (typeof input === 'string') {
    try {
      source = parseJsonObject<unknown>(input)
    } catch {
      return undefined
    }
  }
  if (!isPlainRecord(source) || typeof source.query !== 'string') return undefined
  const query = source.query.trim()
  return query.length > 0 ? query : undefined
}

/** Narrows unknown values to plain records for safe tool argument/result access. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 completeWithTools 包装成 harness 有界搜索循环的每轮调用（design §4.1 C2）：
 * tool_calls 轮透传；纯文本轮沿用 parseJsonObject 宽容解析（fenced JSON 兜底）
 * 后再字符串化，完全不可解析时抛错，由 compose 落回确定性 composer（§4.3）。
 */
export function createComposeToolLoopFn(
  adapter: ChatCompletionsAdapter,
): CustomerServiceToolLoopFn {
  return async (messages, tools) => {
    const reply = await adapter.completeWithTools(messages, tools)
    if ('toolCalls' in reply) return reply
    return { text: JSON.stringify(parseJsonObject<Record<string, unknown>>(reply.text)) }
  }
}

/** playground direct Chat Completions 搜索循环：仅在显式关闭 SDK 时使用。 */
export function createPlaygroundToolLoopFn(): CustomerServiceToolLoopFn | undefined {
  if (isLlmExplicitlyDisabled()) return undefined
  if (!readLlmEnv().apiKey) return undefined
  if (!isAgentsSdkExplicitlyDisabled()) return undefined
  return createComposeToolLoopFn(createChatCompletionsAdapterFromEnv())
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
 * Builds the playground LLM hooks as one per-request runtime so modelFn and
 * toolLoopFn share the same pro-model telemetry collector.
 */
export function createPlaygroundLlmRuntime(options: LlmRuntimeOptions = {}): {
  mode: LlmRuntimeMode
  modelFn: CustomerServiceModelFn | undefined
  toolLoopFn: CustomerServiceToolLoopFn | undefined
  summary: () => LlmTelemetrySummary
} {
  const env = readLlmEnv()
  const records: ChatCompletionTelemetry[] = []
  const callBudget = options.callBudget ?? DEFAULT_LLM_CALL_BUDGET
  if (isLlmExplicitlyDisabled() || !env.apiKey) {
    return {
      mode: 'disabled',
      modelFn: undefined,
      toolLoopFn: undefined,
      summary: () => createLlmTelemetrySummary(env.chatModel, records, { callBudget }),
    }
  }
  if (!isAgentsSdkExplicitlyDisabled()) {
    return {
      mode: 'agents-sdk',
      modelFn: createAgentsSdkComposeModelFn(),
      toolLoopFn: undefined,
      summary: () => createLlmTelemetrySummary(env.chatModel, records, { callBudget }),
    }
  }
  const adapter = createChatCompletionsAdapterFromEnv({
    maxOutputTokens: 320,
    telemetry: (record) => records.push(record),
  })
  return {
    mode: 'chat-completions',
    modelFn: createComposeModelFn(adapter),
    toolLoopFn: createComposeToolLoopFn(adapter),
    summary: () => createLlmTelemetrySummary(env.chatModel, records, { callBudget }),
  }
}
