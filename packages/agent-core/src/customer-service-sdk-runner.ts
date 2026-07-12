import type { JsonValue, RuntimeToolCall } from "@rental/shared";
import { z } from "zod";
import {
  CUSTOMER_SERVICE_SDK_INSTRUCTIONS,
  type CustomerServiceActionKind,
  type CustomerServiceSdkRunner,
  type CustomerServiceTaskKind,
  type CustomerServiceToolChoice,
} from "./customer-harness.js";
import { ApprovalRequiredError, PolicyDenyError } from "./tools/registry.js";

/**
 * Zod schemas for the four customer-service tools the SDK lane can expose.
 * Standard-endpoint (non-strict) function calling; the executor's policy gate
 * and bad-argument retries own argument correctness (see ADR 0001 §2).
 */
export const SDK_TOOL_SCHEMAS = {
  search_knowledge: z.object({ query: z.string() }).strict(),
  check_availability: z
    .object({ size: z.string(), startDate: z.string(), endDate: z.string() })
    .strict(),
  create_handoff: z
    .object({ reason: z.string(), context: z.string().nullable() })
    .strict(),
  schedule_followup: z
    .object({ dueAt: z.string(), reason: z.string() })
    .strict(),
} as const;

/** One SDK-exposed tool; structurally compatible with the llm adapter's function-tool shape. */
export type CustomerServiceSdkTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown> | z.ZodType;
  needsApproval: boolean;
  execute: (raw: unknown) => Promise<JsonValue>;
};

/**
 * Injected SDK model/tool-loop factory. The caller (apps/web or eval) binds a
 * DeepSeek Agents SDK runner here; agent-core stays SDK-free and only assembles
 * the bounded customer-service run. Returns a thunk producing the final reply.
 */
export type SdkStructuredRunFactory = (opts: {
  instructions: string;
  input: string;
  tools: CustomerServiceSdkTool[];
  toolChoice: CustomerServiceToolChoice;
  toolUseBehavior: "run_llm_again";
  maxTurns: number;
  signal?: AbortSignal;
}) => () => Promise<{ reply: string }>;

/** Renders task, tool policy, and dynamic context in a cache-friendly stable order. */
export function buildSdkPrompt(
  runtime: Parameters<CustomerServiceSdkRunner>[0],
): string {
  const [task, ...dynamicFragments] = runtime.context.fragments;
  const render = (fragment: (typeof runtime.context.fragments)[number]) =>
    `## ${fragment.label}\n${fragment.content}`;
  return [
    task ? render(task) : "",
    `## 当前工具策略\n允许工具：${runtime.runPolicy.toolNames.join(", ") || "无"}\n工具选择：${runtime.runPolicy.toolChoice}`,
    ...dynamicFragments.map(render),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Derives the auditable action summary from the deterministic scheduled task. */
export function actionForTask(
  kind: CustomerServiceTaskKind,
): CustomerServiceActionKind {
  if (kind === "collect_missing_info") return "ask_missing_info";
  if (kind === "answer_question") return "answer_question";
  if (kind === "check_availability") return "check_availability";
  if (kind === "handoff") return "handoff";
  return "schedule_followup";
}

/**
 * Builds the single production customer-service SDK runner. The harness owns task
 * scheduling, tool policy, prompt context, registry/policy gating, and trace; the
 * injected `runStructured` owns model/tool orchestration. Shared by apps/web and
 * eval so both exercise the identical lane (ADR 0001 Phase 3 #1).
 */
export function createCustomerServiceSdkRunner(
  runStructured: SdkStructuredRunFactory,
  options: { modelName?: string } = {},
): CustomerServiceSdkRunner {
  const modelName = options.modelName ?? "deepseek-v4-pro";
  return async (runtime) => {
    const toolCalls: RuntimeToolCall[] = [];
    const toolResults: JsonValue[] = [];
    const tools: CustomerServiceSdkTool[] = runtime.runPolicy.toolNames.map(
      (name) => {
        const capability = runtime.registry.get(name);
        if (!capability)
          throw new Error(`required SDK tool is not registered: ${name}`);
        return {
          name,
          description: capability.description,
          // DeepSeek 标准端点走非-strict function calling；Agents SDK 要求 zod 参数
          // 必须 strict，故给 SDK 传纯 JSON schema，参数校验仍由下面的 zod .parse 兜底。
          parameters: z.toJSONSchema(SDK_TOOL_SCHEMAS[name]) as Record<
            string,
            unknown
          >,
          needsApproval: capability.approvalRequired,
          execute: async (raw: unknown): Promise<JsonValue> => {
            const parsed = SDK_TOOL_SCHEMAS[name].parse(
              raw,
            ) as unknown as Record<string, JsonValue>;
            const args = {
              ...parsed,
              ...(name === "check_availability"
                ? {
                    productId:
                      runtime.event.productId ?? runtime.memory.productId ?? "",
                  }
                : {}),
              ...(name === "create_handoff" || name === "schedule_followup"
                ? { conversationId: runtime.event.conversationId }
                : {}),
            };
            const call: RuntimeToolCall = {
              toolName: name,
              arguments: args,
              risk: capability.risk,
              approvalRequired: capability.approvalRequired,
            };
            toolCalls.push(call);
            runtime.emitEvent?.("tool_attempted", call as unknown as JsonValue);
            let result: JsonValue;
            try {
              result = await runtime.registry.invokeWithPolicy(
                name,
                args,
                runtime.policy,
                { sessionStatus: runtime.sessionStatus },
                { signal: runtime.signal },
              );
            } catch (error) {
              if (
                !(error instanceof ApprovalRequiredError) &&
                !(error instanceof PolicyDenyError)
              ) {
                throw error;
              }
              result = { error: error.name, message: error.message };
            }
            toolResults.push(result);
            runtime.emitEvent?.("tool_completed", { toolName: name, result });
            if (
              name === "search_knowledge" &&
              result &&
              typeof result === "object"
            ) {
              const output = (result as { output?: unknown }).output;
              if (typeof output === "string") {
                runtime.context.fragments.push({
                  kind: "knowledge",
                  label: "知识库工具结果",
                  content: output,
                });
              }
            }
            return result;
          },
        };
      },
    );
    const runSdk = runStructured({
      instructions: CUSTOMER_SERVICE_SDK_INSTRUCTIONS,
      input: buildSdkPrompt(runtime),
      tools,
      toolChoice: runtime.runPolicy.toolChoice,
      toolUseBehavior: runtime.runPolicy.toolUseBehavior,
      maxTurns: runtime.runPolicy.maxTurns,
      signal: runtime.signal,
    });
    runtime.emitEvent?.("model_called", { model: modelName });
    const output = await runSdk();
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
    };
  };
}
