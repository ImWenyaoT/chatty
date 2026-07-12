import type OpenAI from "openai";
import { createOpenAiClientFromEnv, readLlmEnv } from "./client-from-env.js";
import {
  estimateCostCny,
  type ChatCompletionTelemetry,
} from "./usage-telemetry.js";

export interface ChatCompletionsAdapterOptions {
  client: OpenAI;
  model: string;
  maxOutputTokens?: number;
  telemetry?: (record: ChatCompletionTelemetry) => void;
}

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 工具定义（Chat Completions function tool 形态）：name/description + JSON Schema。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 模型发起的一次工具调用；arguments 为原始 JSON 字符串，解析与容错归调用方。 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

/** 工具循环消息：基础三角色之上扩展 assistant 携带 toolCalls 与 role:'tool' 回填。 */
export type ToolLoopMessage =
  | ChatCompletionMessage
  | { role: "assistant"; content: string; toolCalls: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; content: string };

/** completeWithTools 的两种回复形态：模型要么请求工具调用，要么给出纯文本。 */
export type CompleteWithToolsResult =
  { toolCalls: ToolCallRequest[] } | { text: string };

export interface ChatCompletionsAdapter {
  complete(messages: ChatCompletionMessage[]): Promise<string>;
  /**
   * Asks the model for a single JSON object. Falls back to parsing the first
   * {...} block in the reply so DeepSeek JSON-mode edge cases still work.
   */
  completeJson<T = unknown>(messages: ChatCompletionMessage[]): Promise<T>;
  /**
   * 带工具的单次补全：不带 response_format
   * （不假设 provider 同时严格支持两者，§4.3）；tools 为空数组时省略该参数，
   * 供有界循环的收尾轮使用（§4.2）。回复解析成 tool_calls 或纯文本两种形态。
   */
  completeWithTools(
    messages: ToolLoopMessage[],
    tools: ToolDefinition[],
  ): Promise<CompleteWithToolsResult>;
}

/**
 * Creates a direct DeepSeek Chat Completions adapter for extraction, eval, and fallback paths.
 */
export function createChatCompletionsAdapter(
  options: ChatCompletionsAdapterOptions,
): ChatCompletionsAdapter {
  return {
    async complete(messages: ChatCompletionMessage[]) {
      const response = await options.client.chat.completions.create({
        model: options.model,
        messages,
        ...(options.maxOutputTokens
          ? { max_tokens: options.maxOutputTokens }
          : {}),
      });
      emitTelemetry(options, "complete", response.usage);

      return response.choices[0]?.message?.content?.trim() ?? "";
    },

    async completeJson<T = unknown>(messages: ChatCompletionMessage[]) {
      const response = await options.client.chat.completions.create({
        model: options.model,
        messages,
        // Hint only; non-strict providers ignore this and we still parse below.
        response_format: { type: "json_object" },
        ...(options.maxOutputTokens
          ? { max_tokens: options.maxOutputTokens }
          : {}),
      });
      emitTelemetry(options, "completeJson", response.usage);

      const raw = response.choices[0]?.message?.content?.trim() ?? "";
      return parseJsonObject<T>(raw);
    },

    async completeWithTools(
      messages: ToolLoopMessage[],
      tools: ToolDefinition[],
    ) {
      const response = await options.client.chat.completions.create({
        model: options.model,
        messages: messages.map(toOpenAiMessage),
        ...(options.maxOutputTokens
          ? { max_tokens: options.maxOutputTokens }
          : {}),
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
      });
      emitTelemetry(options, "completeWithTools", response.usage);
      const message = response.choices[0]?.message;
      const toolCalls = (message?.tool_calls ?? [])
        .filter((call) => call.type === "function")
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        }));
      if (toolCalls.length > 0) return { toolCalls };
      return { text: message?.content?.trim() ?? "" };
    },
  };
}

/** Emits normalized provider usage plus a CNY estimate using observed July 2026 DeepSeek rates. */
function emitTelemetry(
  options: ChatCompletionsAdapterOptions,
  operation: ChatCompletionTelemetry["operation"],
  usage: unknown,
) {
  if (!options.telemetry) return;
  const record = normalizeUsage(options.model, operation, usage);
  if (record) options.telemetry(record);
}

/** Normalizes DeepSeek OpenAI-format usage fields, including cache hit/miss counters. */
function normalizeUsage(
  model: string,
  operation: ChatCompletionTelemetry["operation"],
  usage: unknown,
): ChatCompletionTelemetry | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const source = usage as Record<string, unknown>;
  const inputCacheHitTokens = numberField(source, "prompt_cache_hit_tokens");
  const inputCacheMissTokens =
    numberField(source, "prompt_cache_miss_tokens") ||
    Math.max(0, numberField(source, "prompt_tokens") - inputCacheHitTokens);
  const outputTokens = numberField(source, "completion_tokens");
  const totalTokens =
    numberField(source, "total_tokens") ||
    inputCacheHitTokens + inputCacheMissTokens + outputTokens;
  return {
    model,
    operation,
    inputCacheHitTokens,
    inputCacheMissTokens,
    outputTokens,
    totalTokens,
    estimatedCostCny: estimateCostCny(model, {
      inputCacheHitTokens,
      inputCacheMissTokens,
      outputTokens,
    }),
  };
}

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 把工具循环消息转成 Chat Completions 线格式（camelCase → snake_case）。 */
function toOpenAiMessage(
  message: ToolLoopMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && "toolCalls" in message) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return message;
}

/**
 * Convenience builder that wires the adapter from the shared env config, so
 * agent-core and route handlers do not each construct an OpenAI client.
 */
export function createChatCompletionsAdapterFromEnv(
  options: Pick<
    ChatCompletionsAdapterOptions,
    "maxOutputTokens" | "telemetry"
  > = {},
): ChatCompletionsAdapter {
  const { chatModel } = readLlmEnv();
  return createChatCompletionsAdapter({
    client: createOpenAiClientFromEnv(),
    model: chatModel,
    ...options,
  });
}

/**
 * 把模型回复解析成 JSON 对象：优先整体 JSON.parse；失败后回退到正则提取
 * 首个 { 到最后一个 } 的块（兼容回复里夹杂说明文字 / markdown 代码块的
 * 非严格 provider）；仍不可解析时抛错并附上回复片段便于排查。
 */
export function parseJsonObject<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as T;
    }
    throw new Error(
      `chat-completions: could not parse JSON from model reply: ${raw.slice(0, 120)}`,
    );
  }
}
