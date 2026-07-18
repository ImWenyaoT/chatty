import { type JsonValue, type RuntimeToolCall } from "@rental/shared";
import { z } from "zod";
import {
  CUSTOMER_SERVICE_SDK_INSTRUCTIONS,
  type CustomerServiceActionKind,
  type CustomerServiceSdkRunner,
} from "./customer-harness.js";
import { executeSearchRequest } from "./search-execution.js";
import { ApprovalRequiredError, PolicyDenyError } from "./tools/registry.js";

export const SDK_TOOL_SCHEMAS = {
  request_customer_information: z
    .object({
      message: z.string(),
      missingFields: z.array(z.string()),
    })
    .strict(),
  search_knowledge: z.object({ query: z.string() }).strict(),
  check_availability: z
    .object({
      size: z.string(),
      quantity: z.number().int().positive().default(1),
      fulfillmentMode: z.enum(["rental", "buyout"]).nullable().default(null),
      startDate: z.string().nullable().default(null),
      endDate: z.string().nullable().default(null),
    })
    .strict(),
  create_order: z
    .object({
      size: z.string(),
      quantity: z.number().int().positive().default(1),
      fulfillmentMode: z.enum(["rental", "buyout"]),
      startDate: z.string().nullable().default(null),
      endDate: z.string().nullable().default(null),
    })
    .strict(),
  confirm_order: z.object({ orderId: z.string() }).strict(),
  cancel_order: z.object({ orderId: z.string() }).strict(),
  create_handoff: z
    .object({ reason: z.string(), context: z.string().nullable() })
    .strict(),
  schedule_followup: z
    .object({ dueAt: z.string(), reason: z.string() })
    .strict(),
} as const;

const TOOL_DESCRIPTIONS: Record<keyof typeof SDK_TOOL_SCHEMAS, string> = {
  request_customer_information:
    "Ask the customer only for information required to complete the current task.",
  search_knowledge:
    "Search verified seller knowledge for policy, price, sizing, care, and product facts.",
  check_availability:
    "Check real availability for a product, size, and rental period.",
  create_order:
    "Create a pending rental or buyout order only after the fulfillment mode and required fields are clear.",
  confirm_order: "Confirm a stored order and apply its inventory allocation.",
  cancel_order: "Cancel a stored order and release its inventory allocation.",
  create_handoff:
    "Create a traceable human handoff with the problem and collected context.",
  schedule_followup: "Create a traceable follow-up task for a future time.",
};

export type CustomerServiceSdkTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown> | z.ZodType;
  needsApproval: boolean;
  execute: (raw: unknown) => Promise<JsonValue>;
};

export type SdkStructuredRunFactory = (opts: {
  instructions: string;
  input: string;
  tools: CustomerServiceSdkTool[];
  toolChoice: "auto";
  toolUseBehavior: "run_llm_again";
  maxTurns: number;
  signal?: AbortSignal;
}) => () => Promise<{ reply: string }>;

function actionForTool(name: string): CustomerServiceActionKind {
  if (name === "request_customer_information") return "ask_missing_info";
  if (name === "check_availability") return "check_availability";
  if (["create_order", "confirm_order", "cancel_order"].includes(name))
    return "manage_order";
  if (name === "create_handoff") return "handoff";
  if (name === "schedule_followup") return "schedule_followup";
  return "answer_question";
}

function isFailedToolResult(result: JsonValue | undefined): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof result.error === "string"
  );
}

/**
 * Builds Chatty's one model-directed Agents SDK runner. The Model chooses from
 * the bounded tool set; the Harness validates, authorizes, executes, and audits.
 */
export function createCustomerServiceSdkRunner(
  runStructured: SdkStructuredRunFactory,
  options: { modelName?: string } = {},
): CustomerServiceSdkRunner {
  const modelName = options.modelName ?? "deepseek-v4-pro";
  return async (runtime) => {
    const toolCalls: RuntimeToolCall[] = [];
    const toolResults: JsonValue[] = [];
    const searchedQueries: string[] = [];
    const failedAttempts = new Map<string, number>();
    const forceHandoff = async (
      failedTool: string,
      error: unknown,
    ): Promise<JsonValue> => {
      runtime.signal?.throwIfAborted();
      const capability = runtime.registry.get("create_handoff");
      if (!capability) throw error;
      const args: Record<string, JsonValue> = {
        conversationId: runtime.event.conversationId,
        reason: `Harness enforced escalation after ${failedTool} failed`,
        context: String(error),
      };
      const call: RuntimeToolCall = {
        toolName: "create_handoff",
        arguments: args,
        risk: capability.risk,
        approvalRequired: capability.approvalRequired,
      };
      toolCalls.push(call);
      runtime.emitEvent?.("tool_attempted", call as unknown as JsonValue);
      const result = await runtime.registry.invoke("create_handoff", args, {
        signal: runtime.signal,
      });
      toolResults.push(result);
      runtime.emitEvent?.("tool_completed", {
        toolName: "create_handoff",
        result,
      });
      return result;
    };
    const recoverOrHandoff = async (
      failedTool: string,
      error: unknown,
    ): Promise<JsonValue> => {
      runtime.signal?.throwIfAborted();
      if (
        error instanceof ApprovalRequiredError ||
        error instanceof PolicyDenyError ||
        failedTool === "create_handoff"
      ) {
        return forceHandoff(failedTool, error);
      }
      const attempts = (failedAttempts.get(failedTool) ?? 0) + 1;
      failedAttempts.set(failedTool, attempts);
      if (attempts >= 2) return forceHandoff(failedTool, error);
      const result: JsonValue = {
        error: "tool_failed",
        message: String(error),
        recoverable: true,
      };
      toolResults.push(result);
      runtime.emitEvent?.("tool_completed", {
        toolName: failedTool,
        result,
      });
      return result;
    };
    const toolNames = Object.keys(SDK_TOOL_SCHEMAS) as Array<
      keyof typeof SDK_TOOL_SCHEMAS
    >;
    const tools: CustomerServiceSdkTool[] = toolNames.flatMap((name) => {
      const local = name === "request_customer_information";
      const capability = local ? undefined : runtime.registry.get(name);
      if (!local && !capability) return [];
      return [
        {
          name,
          description: TOOL_DESCRIPTIONS[name],
          parameters: z.toJSONSchema(SDK_TOOL_SCHEMAS[name]) as Record<
            string,
            unknown
          >,
          needsApproval: capability?.approvalRequired ?? false,
          execute: async (raw: unknown): Promise<JsonValue> => {
            if (name === "request_customer_information") {
              const args = SDK_TOOL_SCHEMAS[name].parse(
                raw,
              ) as unknown as Record<string, JsonValue>;
              const call: RuntimeToolCall = {
                toolName: name,
                arguments: args,
                risk: "low",
                approvalRequired: false,
              };
              const result: JsonValue = {
                ok: true,
                waitingFor: "customer",
                ...args,
              };
              toolCalls.push(call);
              toolResults.push(result);
              runtime.emitEvent?.(
                "tool_attempted",
                call as unknown as JsonValue,
              );
              runtime.emitEvent?.("tool_completed", { toolName: name, result });
              return result;
            }

            if (name === "search_knowledge") {
              let result;
              try {
                result = await executeSearchRequest({
                  toolName: name,
                  input: raw,
                  registry: runtime.registry,
                  searchedQueries,
                  sessionStatus: runtime.sessionStatus,
                  policy: runtime.policy,
                  signal: runtime.signal,
                  onAttempt: (call) => {
                    toolCalls.push(call);
                    runtime.emitEvent?.(
                      "tool_attempted",
                      call as unknown as JsonValue,
                    );
                  },
                });
              } catch (error) {
                return recoverOrHandoff(name, error);
              }
              if (result.kind === "retry") return result.output;
              searchedQueries.push(String(result.toolCall.arguments.query));
              toolResults.push(result.toolResult);
              runtime.context.fragments.push(result.fragment);
              runtime.emitEvent?.("tool_completed", {
                toolName: name,
                result: result.toolResult,
              });
              return result.output;
            }

            const args = {
              ...(SDK_TOOL_SCHEMAS[name].parse(raw) as unknown as Record<
                string,
                JsonValue
              >),
              ...(name === "check_availability" || name === "create_order"
                ? {
                    productId:
                      runtime.event.productId ?? runtime.memory.productId ?? "",
                  }
                : {}),
              ...(["create_order", "confirm_order", "cancel_order"].includes(
                name,
              )
                ? {
                    customerId: runtime.event.customerId,
                    conversationId: runtime.event.conversationId,
                    requestId: runtime.event.eventId,
                  }
                : {}),
              ...(name === "create_handoff" || name === "schedule_followup"
                ? { conversationId: runtime.event.conversationId }
                : {}),
            };
            const call: RuntimeToolCall = {
              toolName: name,
              arguments: args,
              risk: capability!.risk,
              approvalRequired: capability!.approvalRequired,
            };
            toolCalls.push(call);
            runtime.emitEvent?.("tool_attempted", call as unknown as JsonValue);
            let result: JsonValue;
            let forcedHandoff = false;
            try {
              result = await runtime.registry.invokeWithPolicy(
                name,
                args,
                runtime.policy,
                { sessionStatus: runtime.sessionStatus },
                { signal: runtime.signal },
              );
            } catch (error) {
              result = await recoverOrHandoff(name, error);
              forcedHandoff =
                toolCalls[toolCalls.length - 1]?.toolName === "create_handoff";
            }
            if (!forcedHandoff && !isFailedToolResult(result)) {
              toolResults.push(result);
              runtime.emitEvent?.("tool_completed", { toolName: name, result });
            }
            return result;
          },
        },
      ];
    });

    const runSdk = runStructured({
      instructions: CUSTOMER_SERVICE_SDK_INSTRUCTIONS,
      input: runtime.context.prompt,
      tools,
      toolChoice: "auto",
      toolUseBehavior: "run_llm_again",
      maxTurns: 4,
      signal: runtime.signal,
    });
    runtime.emitEvent?.("model_called", { model: modelName });
    const output = await runSdk();
    if (!output.reply.trim())
      throw new Error("customer-service agent returned an empty reply");
    let reply = output.reply;
    if (isFailedToolResult(toolResults[toolResults.length - 1])) {
      const failedTool = toolCalls[toolCalls.length - 1]?.toolName ?? "unknown";
      await forceHandoff(failedTool, toolResults[toolResults.length - 1]);
      reply = "业务系统暂时无法完成处理，已创建可追踪的人工处理任务。";
    }
    const selectedTool = toolCalls[toolCalls.length - 1];
    const action = selectedTool
      ? actionForTool(selectedTool.toolName)
      : "answer_question";
    if (
      selectedTool &&
      isFailedToolResult(toolResults[toolResults.length - 1])
    ) {
      throw new Error(
        `customer-service task did not complete successfully: ${selectedTool.toolName}`,
      );
    }
    return {
      reply,
      action: {
        action,
        reply,
        toolName: selectedTool?.toolName,
        toolArgs: selectedTool?.arguments,
      },
      toolCalls,
      toolResults,
      outputValidated: true,
    };
  };
}
