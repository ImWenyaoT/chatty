import type {
  AgentSessionStatus,
  AgentStepResult,
  AgentStepTerminality,
  ConversationEvent,
  JsonValue,
  MemorySnapshot,
  RuntimeToolCall,
  RuntimeToolRisk,
} from "@rental/shared";
import { readQuestionFromEvent } from "@rental/shared";
import { createDefaultPolicy, type Policy } from "./policies/policy.js";
import type { ToolRegistry } from "./tools/registry.js";
import { loadChattyAgentInstructions } from "./agent-instructions.js";

export type CustomerServiceTaskKind =
  | "collect_missing_info"
  | "answer_question"
  | "check_availability"
  | "handoff"
  | "follow_up"
  | "order";

export interface CustomerServiceTask {
  kind: CustomerServiceTaskKind;
  goal: string;
  terminality: AgentStepTerminality;
  requiredContext: string[];
  risk: RuntimeToolRisk;
}

export type CustomerServiceActionKind =
  | "ask_missing_info"
  | "answer_question"
  | "check_availability"
  | "recommend_size"
  | "handoff"
  | "schedule_followup"
  | "manage_order";

export interface CustomerServiceContextFragment {
  kind: "task" | "user_message" | "memory" | "product" | "order" | "knowledge";
  label: string;
  content: string;
}

export interface CustomerServiceContext {
  fragments: CustomerServiceContextFragment[];
  prompt: string;
}

export interface CustomerServiceAction {
  action: CustomerServiceActionKind;
  reply: string;
  toolName?: string;
  toolArgs?: Record<string, JsonValue>;
}

export interface CustomerServiceTrace {
  traceId: string;
  task: CustomerServiceTask;
  context: CustomerServiceContext;
  action: CustomerServiceAction;
  toolCalls: RuntimeToolCall[];
  toolResults: JsonValue[];
  sdk?: {
    runStatus: "completed";
    outputValidated: boolean;
    failureKind?: string;
  };
}

export interface CustomerServiceHarnessStepResult {
  step: AgentStepResult;
  trace: CustomerServiceTrace;
}

export interface CustomerServiceSdkRunResult {
  reply: string;
  action: CustomerServiceAction;
  toolCalls: RuntimeToolCall[];
  toolResults: JsonValue[];
  outputValidated: true;
}

export type CustomerServiceSdkRunner = (input: {
  context: CustomerServiceContext;
  event: ConversationEvent;
  memory: MemorySnapshot;
  registry: ToolRegistry;
  sessionStatus: AgentSessionStatus;
  policy: Policy;
  runId?: string;
  signal?: AbortSignal;
  emitEvent?: (type: string, payload?: JsonValue) => void;
}) => Promise<CustomerServiceSdkRunResult>;

export interface RunCustomerServiceHarnessStepInput {
  event: ConversationEvent;
  memory: MemorySnapshot;
  registry: ToolRegistry;
  sessionStatus?: AgentSessionStatus;
  policy?: Policy;
  sdkRunner: CustomerServiceSdkRunner;
  runId?: string;
  signal?: AbortSignal;
  emitEvent?: (type: string, payload?: JsonValue) => void;
}

export const CUSTOMER_SERVICE_SDK_INSTRUCTIONS = loadChattyAgentInstructions();

/** Builds only observable turn context; the Model, not a regex router, identifies the task. */
export function buildCustomerServiceContext(
  input: Pick<RunCustomerServiceHarnessStepInput, "event" | "memory">,
): CustomerServiceContext {
  const fragments: CustomerServiceContextFragment[] = [
    {
      kind: "user_message",
      label: "用户本轮消息",
      content: readQuestionFromEvent(input.event),
    },
  ];

  if (
    input.memory.recentMessages.length > 0 ||
    input.memory.customerMemory ||
    input.memory.productMemory
  ) {
    fragments.push({
      kind: "memory",
      label: "记忆与最近对话",
      content: JSON.stringify(
        {
          recentMessages: input.memory.recentMessages,
          customerMemory: input.memory.customerMemory ?? null,
          productMemory: input.memory.productMemory ?? null,
        },
        null,
        2,
      ),
    });
  }

  const productId = input.event.productId ?? input.memory.productId;
  if (productId) {
    fragments.push({
      kind: "product",
      label: "商品上下文",
      content: `productId=${productId}`,
    });
  }

  return {
    fragments,
    prompt: fragments
      .map((fragment) => `## ${fragment.label}\n${fragment.content}`)
      .join("\n\n"),
  };
}

function outcomeForAction(action: CustomerServiceActionKind): {
  task: CustomerServiceTask;
  nextStatus: AgentSessionStatus;
} {
  const kind: CustomerServiceTaskKind =
    action === "ask_missing_info"
      ? "collect_missing_info"
      : action === "check_availability"
        ? "check_availability"
        : action === "handoff"
          ? "handoff"
          : action === "schedule_followup"
            ? "follow_up"
            : action === "manage_order"
              ? "order"
              : "answer_question";
  const terminality: AgentStepTerminality =
    kind === "handoff"
      ? "handoff_and_wait"
      : kind === "follow_up"
        ? "schedule_and_wait"
        : kind === "check_availability"
          ? "tool_then_continue"
          : kind === "order"
            ? "tool_then_continue"
            : "reply_and_wait";
  return {
    task: {
      kind,
      goal: `完成 ${kind} 客服任务`,
      terminality,
      requiredContext: [],
      risk: "low",
    },
    nextStatus: kind === "handoff" ? "waiting_for_human" : "waiting_for_user",
  };
}

/** Runs one bounded, model-directed customer-service turn through the Agents SDK. */
export async function runCustomerServiceHarnessStep(
  input: RunCustomerServiceHarnessStepInput,
): Promise<CustomerServiceHarnessStepResult> {
  const context = buildCustomerServiceContext(input);
  const executed = await input.sdkRunner({
    context,
    event: input.event,
    memory: input.memory,
    registry: input.registry,
    sessionStatus: input.sessionStatus ?? "active",
    policy: input.policy ?? createDefaultPolicy(),
    runId: input.runId,
    signal: input.signal,
    emitEvent: input.emitEvent,
  });
  const { task, nextStatus } = outcomeForAction(executed.action.action);
  context.fragments.unshift({
    kind: "task",
    label: "已完成客服任务",
    content: task.kind,
  });
  const traceId = input.event.traceId ?? input.event.eventId;
  return {
    step: {
      sessionId: input.event.conversationId,
      traceId,
      terminality: task.terminality,
      reply: executed.reply,
      toolCalls: executed.toolCalls,
      nextStatus,
      memoryPatch: {
        lastHarnessTask: task.kind,
        lastHarnessAction: executed.action.action,
      },
    },
    trace: {
      traceId,
      task,
      context,
      action: executed.action,
      toolCalls: executed.toolCalls,
      toolResults: executed.toolResults,
      sdk: {
        runStatus: "completed",
        outputValidated: executed.outputValidated,
      },
    },
  };
}
