/**
 * LLM 单次调用的归一化遥测记录与成本估算，跨 chat-completions 与 agents-sdk
 * 两条 lane 共用，避免 DeepSeek 费率表在多处重复而漂移。
 */

/** 一次模型调用的归一化遥测：cache 命中/未命中、输出 token 与人民币成本。 */
export interface ChatCompletionTelemetry {
  model: string
  operation: 'complete' | 'completeJson' | 'completeWithTools' | 'agentsSdkRun'
  inputCacheHitTokens: number
  inputCacheMissTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostCny: number
}

/**
 * 用观测到的 2026-07 DeepSeek 费率估算一次调用的人民币成本。cache 命中远比
 * 未命中便宜，正是 KV cache 观测的成本意义所在。
 */
export function estimateCostCny(
  model: string,
  usage: Pick<
    ChatCompletionTelemetry,
    'inputCacheHitTokens' | 'inputCacheMissTokens' | 'outputTokens'
  >,
): number {
  const rates = model.includes('flash')
    ? { hit: 0.00000002, miss: 0.000001, output: 0.000002 }
    : { hit: 0.000000025, miss: 0.000003, output: 0.000006 }
  const cost =
    usage.inputCacheHitTokens * rates.hit +
    usage.inputCacheMissTokens * rates.miss +
    usage.outputTokens * rates.output
  return Number(cost.toFixed(12))
}

/** Agents SDK 的 Usage 形态（inputTokensDetails 为数组，含 cached_tokens）。 */
export type AgentsSdkUsageLike = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokensDetails?: Array<Record<string, number>> | Record<string, number>
}

/** 从 inputTokensDetails（数组或对象）累计 cache 命中 token 数。 */
function readCachedTokens(details: AgentsSdkUsageLike['inputTokensDetails']): number {
  if (Array.isArray(details)) {
    return details.reduce((sum, entry) => sum + (Number(entry?.cached_tokens) || 0), 0)
  }
  return Number(details?.cached_tokens) || 0
}

/**
 * 把 Agents SDK 的 Usage 归一成遥测记录：cached_tokens 计为命中，其余输入 token
 * 计为未命中（SDK 已从 DeepSeek 的 prompt_tokens_details.cached_tokens 透传）。
 */
export function agentsSdkUsageToTelemetry(
  model: string,
  usage: AgentsSdkUsageLike | undefined,
): ChatCompletionTelemetry {
  const inputCacheHitTokens = readCachedTokens(usage?.inputTokensDetails)
  const inputTokens = Number(usage?.inputTokens) || 0
  const outputTokens = Number(usage?.outputTokens) || 0
  const inputCacheMissTokens = Math.max(0, inputTokens - inputCacheHitTokens)
  const totalTokens = Number(usage?.totalTokens) || inputTokens + outputTokens
  return {
    model,
    operation: 'agentsSdkRun',
    inputCacheHitTokens,
    inputCacheMissTokens,
    outputTokens,
    totalTokens,
    estimatedCostCny: estimateCostCny(model, {
      inputCacheHitTokens,
      inputCacheMissTokens,
      outputTokens,
    }),
  }
}
