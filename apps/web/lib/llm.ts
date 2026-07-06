import {
  CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
  executeSearchRequest,
  type CustomerServiceModelFn,
  type CustomerServiceToolLoopFn,
} from '@rental/agent-core'
import {
  type ChatCompletionTelemetry,
  createDeepSeekAgentsSdkToolLoop,
  parseJsonObject,
  readLlmEnv,
} from '@rental/llm'
import { readQuestionFromEvent } from '@rental/shared'

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
  if (!env.apiKey) {
    return {
      mode: 'disabled',
      modelFn: undefined,
      toolLoopFn: undefined,
      summary: () => createLlmTelemetrySummary(env.chatModel, records, { callBudget }),
    }
  }
  return {
    mode: 'agents-sdk',
    modelFn: createAgentsSdkComposeModelFn(records),
    toolLoopFn: undefined,
    summary: () => createLlmTelemetrySummary(env.chatModel, records, { callBudget }),
  }
}
