import {
  Agent,
  OpenAIChatCompletionsModel,
  run,
  setTracingDisabled,
  tool,
  type FunctionTool,
  type Model,
} from "@openai/agents";
import OpenAI from "openai";
import { z } from "zod";
import { readLlmEnv } from "./client-from-env.js";
import {
  agentsSdkUsageToTelemetry,
  type ChatCompletionTelemetry,
} from "./usage-telemetry.js";

export type AgentsSdkRuntimeTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown> | z.ZodType;
  needsApproval?: boolean;
  execute(input: unknown): Promise<unknown> | unknown;
};

export type AgentsSdkToolLoopOptions = {
  instructions: string;
  input?: string;
  model: Model;
  /** 用于遥测记录的模型名（Model 对象本身不带名字）。 */
  modelName?: string;
  name?: string;
  tools?: AgentsSdkRuntimeTool[];
  maxTurns?: number;
  /** 每次 SDK model 调用回传一条归一化遥测（含 KV cache 命中）。 */
  telemetry?: (record: ChatCompletionTelemetry) => void;
  toolChoice?: "auto" | "required" | "none" | (string & {});
  toolUseBehavior?:
    "run_llm_again" | "stop_on_first_tool" | { stopAtToolNames: string[] };
  signal?: AbortSignal;
};

export const CUSTOMER_SERVICE_FINAL_OUTPUT_SCHEMA = z
  .object({ reply: z.string().min(1) })
  .strict();

export type CustomerServiceFinalOutput = z.infer<
  typeof CUSTOMER_SERVICE_FINAL_OUTPUT_SCHEMA
>;

export type AgentsSdkStructuredRunnerOptions<TSchema extends z.ZodObject> =
  AgentsSdkToolLoopOptions & { outputType: TSchema; outputExample: string };

/**
 * Builds the Agents SDK Chat Completions model around DeepSeek's OpenAI-format
 * endpoint. The SDK provides the model abstraction; Chatty keeps DeepSeek as
 * the only configured model lane.
 */
export function createDeepSeekAgentsModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Model {
  const { apiKey, baseURL, chatModel } = readLlmEnv(env);
  const client = new OpenAI({
    apiKey,
    baseURL,
    fetch: createDeepSeekCompatibleFetch(),
  });
  return new OpenAIChatCompletionsModel(client as never, chatModel, {
    strictFeatureValidation: true,
  });
}

/** Maps Agents SDK json_schema output requests to DeepSeek's supported json_object wire format. */
export function createDeepSeekCompatibleFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.includes("/chat/completions") || typeof init?.body !== "string") {
      return baseFetch(input, init);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return baseFetch(input, init);
    }
    const responseFormat = body.response_format;
    if (
      responseFormat &&
      typeof responseFormat === "object" &&
      (responseFormat as { type?: unknown }).type === "json_schema"
    ) {
      body.response_format = { type: "json_object" };
    }
    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * Converts a Chatty runtime tool definition into an OpenAI Agents SDK function
 * tool so schema exposure, invocation, and approval semantics are SDK-owned.
 */
export function toAgentsSdkFunctionTool(
  definition: AgentsSdkRuntimeTool,
): FunctionTool {
  return tool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as never,
    // strict function calling 是 DeepSeek beta 专属能力；标准端点用非 strict 工具，
    // 参数正确性交给 Chatty 执行器 policy 校验与坏参数重试兜底。
    strict: false,
    needsApproval: definition.needsApproval ?? false,
    execute: async (input) => {
      const result = await definition.execute(input);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  });
}

/**
 * Creates an SDK-backed compose loop. The SDK owns model/tool orchestration;
 * callers still own business task scheduling, prompt construction, trace
 * persistence, and DeepSeek fallback policy.
 */
export function createAgentsSdkToolLoopFn(options: AgentsSdkToolLoopOptions) {
  setTracingDisabled(true);
  const agent = new Agent({
    name: options.name ?? "Chatty customer-service composer",
    instructions: options.instructions,
    model: options.model,
    tools: (options.tools ?? []).map(toAgentsSdkFunctionTool),
    modelSettings: {
      parallelToolCalls: false,
      toolChoice: options.toolChoice,
      providerData: { thinking: { type: "disabled" } },
    },
    toolUseBehavior: options.toolUseBehavior ?? "run_llm_again",
  });

  const modelName = options.modelName ?? "deepseek-v4-pro";

  return async (input: string): Promise<string> => {
    const result = await run(agent, input, {
      maxTurns: options.maxTurns ?? 4,
      signal: options.signal,
    });
    if (options.telemetry) {
      for (const response of result.rawResponses ?? []) {
        options.telemetry(agentsSdkUsageToTelemetry(modelName, response.usage));
      }
    }
    return String(result.finalOutput ?? "");
  };
}

/** Runs one structured, bounded customer-service turn through a clone of one base Agent. */
export function createAgentsSdkCustomerServiceRunner(
  options: AgentsSdkToolLoopOptions,
) {
  return createAgentsSdkStructuredRunner({
    ...options,
    outputType: CUSTOMER_SERVICE_FINAL_OUTPUT_SCHEMA,
    outputExample: '{"reply":"..."}',
  });
}

/**
 * Runs one bounded customer-service turn as a plain tool loop and returns the
 * final reply. Unlike the structured runner it does NOT set the Agents SDK
 * `outputType`: DeepSeek does not support `response_format: json_schema` on any
 * endpoint, and its `json_object` structured output does not converge when tools
 * are present (the SDK loops to maxTurns). The model replies as plain short text;
 * the reply is extracted leniently, tolerating an optional `{reply}` JSON wrap.
 */
export function createAgentsSdkCustomerServiceTextRunner(
  options: AgentsSdkToolLoopOptions,
): () => Promise<{ reply: string }> {
  const runLoop = createAgentsSdkToolLoopFn(options);
  return async () => {
    const text = await runLoop(options.input ?? options.instructions);
    return { reply: extractCustomerServiceReply(text) };
  };
}

/** Extracts the user-facing reply from the model's final text, tolerating a {reply} JSON wrap. */
function extractCustomerServiceReply(text: string): string {
  const trimmed = text.trim();
  const replyFromJson = (candidate: string): string | undefined => {
    try {
      const parsed = JSON.parse(candidate) as { reply?: unknown };
      return typeof parsed.reply === "string" ? parsed.reply : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = replyFromJson(trimmed);
  if (direct !== undefined) return direct;
  const block = trimmed.match(/\{[\s\S]*\}/);
  if (block) {
    const embedded = replyFromJson(block[0]);
    if (embedded !== undefined) return embedded;
  }
  return trimmed;
}

/** Runs one bounded structured-output clone of the single base Chatty Agent. */
export function createAgentsSdkStructuredRunner<TSchema extends z.ZodObject>(
  options: AgentsSdkStructuredRunnerOptions<TSchema>,
) {
  setTracingDisabled(true);
  const baseAgent = Agent.create({
    name: options.name ?? "Chatty Customer Service Agent",
    instructions: `${options.instructions}\nFinal output must be one JSON object shaped like ${options.outputExample}.`,
    model: options.model,
    outputType: options.outputType,
    tools: [],
  });
  const modelName = options.modelName ?? "deepseek-v4-pro";

  return async (): Promise<z.infer<TSchema>> => {
    const agent = baseAgent.clone({
      tools: (options.tools ?? []).map(toAgentsSdkFunctionTool),
      modelSettings: {
        parallelToolCalls: false,
        toolChoice: options.toolChoice,
        providerData: { thinking: { type: "disabled" } },
      },
      toolUseBehavior: options.toolUseBehavior ?? "run_llm_again",
    });
    const result = await run(agent, options.input ?? options.instructions, {
      maxTurns: options.maxTurns ?? 4,
      signal: options.signal,
    });
    if (options.telemetry) {
      for (const response of result.rawResponses ?? []) {
        options.telemetry(agentsSdkUsageToTelemetry(modelName, response.usage));
      }
    }
    return options.outputType.parse(result.finalOutput) as z.infer<TSchema>;
  };
}

/**
 * Convenience builder for production wiring: DeepSeek model from env plus SDK
 * tool loop from the supplied harness instructions/tools.
 */
export function createDeepSeekAgentsSdkToolLoop(
  options: Omit<AgentsSdkToolLoopOptions, "model">,
) {
  return createAgentsSdkToolLoopFn({
    ...options,
    model: createDeepSeekAgentsModelFromEnv(),
    modelName: options.modelName ?? readLlmEnv().chatModel,
  });
}
