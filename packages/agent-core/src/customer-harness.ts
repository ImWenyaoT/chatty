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

const POLICY_FACT_PATTERN =
  /怎么租|如何租|流程|押金|规则|租期|计费|续租|售后|换码|换货|不合身|换吗|店名|电话|地址|营业|清洗|自己洗|洗吗|洗护|包邮/;
const PRODUCT_FACT_PATTERN =
  /价格|多少钱|租金|一天|费用|尺码|材质|颜色|款式|当前链接|这款吗/;
const PRICE_FACT_PATTERN = /价格|多少钱|租金|一天|费用/;

export type CustomerServiceTaskKind =
  | "collect_missing_info"
  | "answer_question"
  | "check_availability"
  | "handoff"
  | "follow_up";

export type CustomerServiceActionKind =
  | "ask_missing_info"
  | "answer_question"
  | "check_availability"
  | "recommend_size"
  | "handoff"
  | "schedule_followup";

export interface CustomerServiceTask {
  kind: CustomerServiceTaskKind;
  goal: string;
  terminality: AgentStepTerminality;
  requiredContext: string[];
  risk: RuntimeToolRisk;
}

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

export type CustomerServiceToolChoice =
  "none" | "auto" | CustomerServiceActionToolName;
export type CustomerServiceActionToolName =
  | "search_knowledge"
  | "check_availability"
  | "create_handoff"
  | "schedule_followup";

export interface CustomerServiceRunPolicy {
  toolNames: CustomerServiceActionToolName[];
  toolChoice: CustomerServiceToolChoice;
  toolUseBehavior: "run_llm_again";
  maxTurns: number;
  terminality: AgentStepTerminality;
  nextStatus: AgentSessionStatus;
}

export interface CustomerServiceSdkRunResult {
  reply: string;
  action: CustomerServiceAction;
  toolCalls: RuntimeToolCall[];
  toolResults: JsonValue[];
  outputValidated: true;
}

export type CustomerServiceSdkRunner = (input: {
  task: CustomerServiceTask;
  runPolicy: CustomerServiceRunPolicy;
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

export interface CustomerServiceTurnInput {
  event: ConversationEvent;
  memory: MemorySnapshot;
}

export interface RunCustomerServiceHarnessStepInput extends CustomerServiceTurnInput {
  registry: ToolRegistry;
  sessionStatus?: AgentSessionStatus;
  policy?: Policy;
  /** The sole runtime lane: one task-aware Agents SDK runner. */
  sdkRunner: CustomerServiceSdkRunner;
  runId?: string;
  signal?: AbortSignal;
  emitEvent?: (type: string, payload?: JsonValue) => void;
}

export const CUSTOMER_SERVICE_SDK_INSTRUCTIONS = [
  "你是 Chatty 的单一租赁电商客服 Agent。Chatty harness 已经确定当前任务和可用工具。",
  "只处理当前任务，不得尝试调用未暴露的工具，也不得自行改变任务类型。",
  "需要工具时必须使用当前提供的 function tool；工具结果回填后，以结果为事实依据。",
  "事实任务中，工具结果是唯一可引用的证据：价格、次数、时限、费用和政策口径必须来自其中；没有明确证据时如实说明需要确认，不能补全或猜测。",
  "当工具选择是 search_knowledge 时，先调用一次精准关键词搜索；收到结果后直接根据结果回答，不要再次搜索。",
  "不要编造商品、库存、政策、工单、提醒时间或系统执行结果。",
  "直接输出发给用户的简短中文回复本身，不要包成 JSON、不要写字段名、任务名或工具名。",
  "回复保持口语化、清晰、务实，不使用 Markdown、编号、内部任务名或工具名。",
].join("\n");

/**
 * Schedules the next bounded customer-service task from the current user turn.
 * This is intentionally deterministic: the LLM may decide wording and action
 * details later, but the harness owns workflow shape and safety posture.
 */
export function scheduleCustomerServiceTask(
  input: CustomerServiceTurnInput,
): CustomerServiceTask {
  const question = readQuestionFromEvent(input.event).toLowerCase();
  if (mentionsHandoff(question)) {
    return {
      kind: "handoff",
      goal: "转人工处理投诉、退款或超出自动处理边界的问题",
      terminality: "handoff_and_wait",
      requiredContext: ["conversationId", "handoffReason"],
      risk: "medium",
    };
  }
  if (mentionsFollowUp(question)) {
    return {
      kind: "follow_up",
      goal: "安排后续提醒或售后跟进",
      terminality: "schedule_and_wait",
      requiredContext: ["conversationId", "dueAt", "reason"],
      risk: "low",
    };
  }
  if (mentionsClarificationRequest(question)) {
    return createCollectMissingInfoTask(
      "先道歉并承认刚才没说清楚，再换一种更简单的说法重述上一轮问题，并解释为什么需要该信息；不要采集新的槽位、罗列多个问题或推进流程",
    );
  }
  if (
    hasRentalPeriod(question) &&
    hasBodyOrSize(question) &&
    input.event.productId
  ) {
    return {
      kind: "check_availability",
      goal: "基于商品、档期和尺码信息检查库存可用性",
      terminality: "tool_then_continue",
      requiredContext: ["productId", "rentalPeriod", "bodyMeasurements"],
      risk: "low",
    };
  }
  if (input.event.productId && /当前链接|这款吗/.test(question)) {
    return createAnswerQuestionTask("确认当前已绑定商品，并引导下一步租赁信息");
  }
  if (
    input.event.productId &&
    hasRentalPeriod(question) &&
    !hasBodyOrSize(question)
  ) {
    return createCollectMissingInfoTask(
      "已确认当前商品和档期；只收集用户身高与体重，不重复询问款式或日期",
    );
  }
  if (mentionsAnswerableFactQuestion(question, input.event.productId)) {
    return createAnswerQuestionTask();
  }
  if (/我.*身高.*体重|身高体重.*来着/.test(question)) {
    const body = readRememberedBodyMeasurements(input.memory);
    if (body) {
      const known = [
        body.heightCm === undefined ? undefined : `身高 ${body.heightCm} cm`,
        body.weightKg === undefined ? undefined : `体重 ${body.weightKg} kg`,
      ].filter((value): value is string => value !== undefined);
      const missing = [
        body.heightCm === undefined ? "身高" : undefined,
        body.weightKg === undefined ? "体重" : undefined,
      ].filter((value): value is string => value !== undefined);
      return createAnswerQuestionTask(
        `根据当前记忆直接回答：${known.join("，")}${missing.length > 0 ? `；${missing.join("和")}还没有记录，只询问缺失项` : ""}；不要否认已知记录或追问商品`,
      );
    }
    return createCollectMissingInfoTask(
      "当前记忆里还没有记录身高体重；如实说明没有记录，并请用户重新提供",
    );
  }
  if (!input.event.productId) {
    return createCollectMissingInfoTask(
      "当前商品尚未确定；只询问款式或商品编号，不询问日期、身高或体重",
    );
  }
  if (!hasEnoughRentalContext(question, input.memory)) {
    return createCollectMissingInfoTask();
  }
  return createAnswerQuestionTask();
}

function createAnswerQuestionTask(
  goal = "回答当前客服问题，并保持下一步流程清晰",
): CustomerServiceTask {
  return {
    kind: "answer_question",
    goal,
    terminality: "reply_and_wait",
    requiredContext: ["userMessage", "recentMessages"],
    risk: "low",
  };
}

function createCollectMissingInfoTask(
  goal = "收集客服履约所需的商品、档期、身高体重或数量信息",
): CustomerServiceTask {
  return {
    kind: "collect_missing_info",
    goal,
    terminality: "reply_and_wait",
    requiredContext: ["productId", "rentalPeriod", "bodyMeasurements"],
    risk: "low",
  };
}

/** Maps one deterministic customer-service task to its bounded Agents SDK run policy. */
export function createCustomerServiceRunPolicy(
  task: CustomerServiceTask,
  options: { requireKnowledgeSearch?: boolean } = {},
): CustomerServiceRunPolicy {
  switch (task.kind) {
    case "collect_missing_info":
      return {
        toolNames: [],
        toolChoice: "none",
        toolUseBehavior: "run_llm_again",
        maxTurns: 1,
        terminality: task.terminality,
        nextStatus: "waiting_for_user",
      };
    case "answer_question":
      return {
        toolNames: ["search_knowledge"],
        toolChoice: options.requireKnowledgeSearch
          ? "search_knowledge"
          : "auto",
        toolUseBehavior: "run_llm_again",
        maxTurns: 4,
        terminality: task.terminality,
        nextStatus: "waiting_for_user",
      };
    case "check_availability":
      return {
        toolNames: ["check_availability"],
        toolChoice: "check_availability",
        toolUseBehavior: "run_llm_again",
        maxTurns: 3,
        terminality: task.terminality,
        nextStatus: "waiting_for_user",
      };
    case "handoff":
      return {
        toolNames: ["create_handoff"],
        toolChoice: "create_handoff",
        toolUseBehavior: "run_llm_again",
        maxTurns: 3,
        terminality: task.terminality,
        nextStatus: "waiting_for_human",
      };
    case "follow_up":
      return {
        toolNames: ["schedule_followup"],
        toolChoice: "schedule_followup",
        toolUseBehavior: "run_llm_again",
        maxTurns: 3,
        terminality: task.terminality,
        nextStatus: "waiting_for_user",
      };
  }
}

/**
 * Builds an ordered, inspectable customer-service prompt context. The same
 * fragments can be rendered in a GUI so users see exactly what shaped a reply.
 */
export function buildCustomerServiceContext(
  input: CustomerServiceTurnInput & {
    task: CustomerServiceTask;
  },
): CustomerServiceContext {
  const fragments: CustomerServiceContextFragment[] = [
    {
      kind: "task",
      label: "当前客服任务",
      content: `${input.task.kind}: ${input.task.goal}`,
    },
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

  if (input.event.productId) {
    fragments.push({
      kind: "product",
      label: "商品上下文",
      content: `productId=${input.event.productId}`,
    });
  }

  const prompt = fragments
    .map((fragment) => `## ${fragment.label}\n${fragment.content}`)
    .join("\n\n");
  return { fragments, prompt };
}

/**
 * Runs one bounded customer-service harness step through the task-aware Agents SDK lane.
 */
export async function runCustomerServiceHarnessStep(
  input: RunCustomerServiceHarnessStepInput,
): Promise<CustomerServiceHarnessStepResult> {
  const task = scheduleCustomerServiceTask(input);
  const context = buildCustomerServiceContext({ ...input, task });
  const runPolicy = createCustomerServiceRunPolicy(task, {
    requireKnowledgeSearch: requiresKnowledgeSearch(
      readQuestionFromEvent(input.event),
    ),
  });
  const executed = await input.sdkRunner({
    task,
    runPolicy,
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
  const traceId = input.event.traceId ?? input.event.eventId;
  return {
    step: {
      sessionId: input.event.conversationId,
      traceId,
      terminality: runPolicy.terminality,
      reply: executed.reply,
      toolCalls: executed.toolCalls,
      nextStatus: runPolicy.nextStatus,
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

/** Requires grounded retrieval for policies and price facts, leaving link confirmation on auto. */
function requiresKnowledgeSearch(question: string): boolean {
  return (
    POLICY_FACT_PATTERN.test(question) || PRICE_FACT_PATTERN.test(question)
  );
}

function mentionsHandoff(question: string): boolean {
  return /投诉|退款|人工|客服|赔偿|差评/.test(question);
}

function mentionsFollowUp(question: string): boolean {
  return /提醒|跟进|到期|明天|后天|稍后/.test(question);
}

function mentionsClarificationRequest(question: string): boolean {
  return /^\s*(?:[？?]|没听懂|不明白|没明白|什么意思)\s*$/.test(question);
}

function readRememberedBodyMeasurements(
  memory: MemorySnapshot,
): { heightCm?: number; weightKg?: number } | undefined {
  const customer = memory.customerMemory;
  if (!isPlainJsonObject(customer)) return undefined;
  const source = isPlainJsonObject(customer.summary)
    ? customer.summary
    : customer;
  if (!Array.isArray(source.bodyProfiles)) return undefined;
  for (const profile of source.bodyProfiles) {
    if (
      isPlainJsonObject(profile) &&
      (typeof profile.heightCm === "number" ||
        typeof profile.weightKg === "number")
    ) {
      return {
        heightCm:
          typeof profile.heightCm === "number" ? profile.heightCm : undefined,
        weightKg:
          typeof profile.weightKg === "number" ? profile.weightKg : undefined,
      };
    }
  }
  return undefined;
}

function mentionsAnswerableFactQuestion(
  question: string,
  productId?: string,
): boolean {
  return (
    POLICY_FACT_PATTERN.test(question) ||
    (Boolean(productId) && PRODUCT_FACT_PATTERN.test(question))
  );
}

function hasRentalPeriod(question: string): boolean {
  return (
    /\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(question) ||
    /\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)?(?:\s*(?:到|至|-|~)\s*(?:(?:\d{1,2}\s*月)?\s*)?\d{1,2}\s*(?:日|号)?)?/.test(
      question,
    )
  );
}

function hasBodyOrSize(question: string): boolean {
  return /身高|体重|kg|公斤|斤|[smlxl]{1,3}\b|码/.test(question);
}

function hasEnoughRentalContext(
  question: string,
  memory: MemorySnapshot,
): boolean {
  return (
    hasRentalPeriod(question) ||
    hasBodyOrSize(question) ||
    memory.recentMessages.length > 0
  );
}

function isPlainJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
