import {
  createCustomerServiceSdkRunner,
  type CustomerServiceSdkRunner,
} from "@rental/agent-core";
import {
  type ChatCompletionTelemetry,
  createAgentsSdkCustomerServiceTextRunner,
  createDeepSeekAgentsModelFromEnv,
  readLlmEnv,
} from "@rental/llm";

export type LlmTelemetrySummary = {
  model: string;
  calls: number;
  callBudget: number;
  inputCacheHitTokens: number;
  inputCacheMissTokens: number;
  inputCacheHitRatio: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostCny: number;
  operations: Array<ChatCompletionTelemetry["operation"]>;
  warnings: string[];
};

type LlmRuntimeOptions = {
  callBudget?: number;
};

type LlmRuntimeMode = "disabled" | "agents-sdk";

const DEFAULT_LLM_CALL_BUDGET = 3;

export class MissingLlmApiKeyError extends Error {
  constructor() {
    super("DeepSeek API key is required");
    this.name = "MissingLlmApiKeyError";
  }
}

/** Builds the single production customer-service SDK runner over the DeepSeek Agents SDK. */
function createPlaygroundSdkRunner(
  records: ChatCompletionTelemetry[] = [],
): CustomerServiceSdkRunner {
  const env = readLlmEnv();
  if (!env.apiKey) throw new MissingLlmApiKeyError();
  const model = createDeepSeekAgentsModelFromEnv();
  return createCustomerServiceSdkRunner(
    (opts) =>
      createAgentsSdkCustomerServiceTextRunner({
        instructions: opts.instructions,
        input: opts.input,
        model,
        modelName: env.chatModel,
        tools: opts.tools,
        toolChoice: opts.toolChoice,
        toolUseBehavior: opts.toolUseBehavior,
        maxTurns: opts.maxTurns,
        telemetry: (record) => records.push(record),
        signal: opts.signal,
      }),
    { modelName: env.chatModel },
  );
}

/** Calculates the normalized prompt/KV cache hit ratio for input tokens. */
function calculateInputCacheHitRatio(
  hitTokens: number,
  missTokens: number,
): number {
  const totalInputTokens = hitTokens + missTokens;
  if (totalInputTokens <= 0) return 0;
  return Number((hitTokens / totalInputTokens).toFixed(4));
}

/** Aggregates per-call LLM telemetry into a compact trace payload for the playground inspector. */
export function createLlmTelemetrySummary(
  model: string,
  records: ChatCompletionTelemetry[],
  options: LlmRuntimeOptions = {},
): LlmTelemetrySummary {
  const callBudget = options.callBudget ?? DEFAULT_LLM_CALL_BUDGET;
  const summary = records.reduce<
    Omit<LlmTelemetrySummary, "inputCacheHitRatio" | "warnings">
  >(
    (summary, record) => ({
      model,
      calls: summary.calls + 1,
      callBudget,
      inputCacheHitTokens:
        summary.inputCacheHitTokens + record.inputCacheHitTokens,
      inputCacheMissTokens:
        summary.inputCacheMissTokens + record.inputCacheMissTokens,
      outputTokens: summary.outputTokens + record.outputTokens,
      totalTokens: summary.totalTokens + record.totalTokens,
      estimatedCostCny: Number(
        (summary.estimatedCostCny + record.estimatedCostCny).toFixed(12),
      ),
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
  );
  const warnings =
    summary.calls > callBudget
      ? [`llm_call_budget_exceeded: ${summary.calls}/${callBudget}`]
      : [];
  return {
    ...summary,
    inputCacheHitRatio: calculateInputCacheHitRatio(
      summary.inputCacheHitTokens,
      summary.inputCacheMissTokens,
    ),
    warnings,
  };
}

/**
 * Builds the playground LLM hooks as one per-request runtime. The Agents SDK
 * runner feeds the shared pro-model telemetry collector per model call.
 */
export function createPlaygroundLlmRuntime(options: LlmRuntimeOptions = {}): {
  mode: LlmRuntimeMode;
  sdkRunner: CustomerServiceSdkRunner;
  summary: () => LlmTelemetrySummary;
} {
  const env = readLlmEnv();
  const records: ChatCompletionTelemetry[] = [];
  const callBudget = options.callBudget ?? DEFAULT_LLM_CALL_BUDGET;
  if (!env.apiKey) {
    throw new MissingLlmApiKeyError();
  }
  return {
    mode: "agents-sdk",
    sdkRunner: createPlaygroundSdkRunner(records),
    summary: () =>
      createLlmTelemetrySummary(env.chatModel, records, { callBudget }),
  };
}
