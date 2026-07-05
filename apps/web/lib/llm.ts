import {
  CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
  type CustomerServiceModelFn,
  type CustomerServiceToolLoopFn,
} from '@rental/agent-core'
import {
  type ChatCompletionTelemetry,
  type ChatCompletionsAdapter,
  createChatCompletionsAdapterFromEnv,
  parseJsonObject,
  readLlmEnv,
} from '@rental/llm'

export type LlmTelemetrySummary = {
  model: string
  calls: number
  inputCacheHitTokens: number
  inputCacheMissTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostCny: number
  operations: Array<ChatCompletionTelemetry['operation']>
}

/**
 * Wraps a Chat Completions adapter into the harness compose modelFn.
 *
 * Goes through completeJson (response_format json_object hint + tolerant
 * extraction of JSON wrapped in ```json fences or surrounding prose — common
 * with OpenAI-compatible endpoints like DeepSeek) instead of raw complete(),
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
 * Builds the optional LLM compose call for the playground harness step.
 *
 * Double gate: CHATTY_LLM=1 must be set explicitly AND OPENAI_API_KEY must be
 * present (client-from-env convention, any OpenAI-compatible endpoint via
 * OPENAI_BASE_URL). Returns undefined otherwise, which keeps the playground on
 * the deterministic composer with zero configuration.
 */
export function createPlaygroundModelFn(): CustomerServiceModelFn | undefined {
  if (process.env.CHATTY_LLM !== '1') return undefined
  if (!readLlmEnv().apiKey) return undefined
  return createComposeModelFn(createChatCompletionsAdapterFromEnv())
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

/** playground 的搜索循环注入：与 createPlaygroundModelFn 相同的双重门控。 */
export function createPlaygroundToolLoopFn(): CustomerServiceToolLoopFn | undefined {
  if (process.env.CHATTY_LLM !== '1') return undefined
  if (!readLlmEnv().apiKey) return undefined
  return createComposeToolLoopFn(createChatCompletionsAdapterFromEnv())
}

/** Aggregates per-call LLM telemetry into a compact trace payload for the playground inspector. */
export function createLlmTelemetrySummary(
  model: string,
  records: ChatCompletionTelemetry[],
): LlmTelemetrySummary {
  return records.reduce<LlmTelemetrySummary>(
    (summary, record) => ({
      model,
      calls: summary.calls + 1,
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
      inputCacheHitTokens: 0,
      inputCacheMissTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostCny: 0,
      operations: [],
    },
  )
}

/**
 * Builds the playground LLM hooks as one per-request runtime so modelFn and
 * toolLoopFn share the same pro-model telemetry collector.
 */
export function createPlaygroundLlmRuntime(): {
  modelFn: CustomerServiceModelFn | undefined
  toolLoopFn: CustomerServiceToolLoopFn | undefined
  summary: () => LlmTelemetrySummary
} {
  const env = readLlmEnv()
  const records: ChatCompletionTelemetry[] = []
  if (process.env.CHATTY_LLM !== '1' || !env.apiKey) {
    return {
      modelFn: undefined,
      toolLoopFn: undefined,
      summary: () => createLlmTelemetrySummary(env.chatModel, records),
    }
  }
  const adapter = createChatCompletionsAdapterFromEnv({
    maxOutputTokens: 320,
    telemetry: (record) => records.push(record),
  })
  return {
    modelFn: createComposeModelFn(adapter),
    toolLoopFn: createComposeToolLoopFn(adapter),
    summary: () => createLlmTelemetrySummary(env.chatModel, records),
  }
}
