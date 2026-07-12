import type {
  AgentSessionStatus,
  AgentStepResult,
  AgentStepTerminality,
  ConversationEvent,
  JsonValue,
  MemorySnapshot,
  RuntimeTool,
  RuntimeToolCall,
  RuntimeToolRisk,
} from "@rental/shared";
import { readQuestionFromEvent } from "@rental/shared";
import { createDefaultPolicy, type Policy } from "./policies/policy.js";
import type { ToolRegistry } from "./tools/registry.js";
import { ApprovalRequiredError, PolicyDenyError } from "./tools/registry.js";
import { executeSearchRequest } from "./search-execution.js";

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

export interface CreateCustomerServiceModelOutputInput extends CustomerServiceTurnInput {
  task: CustomerServiceTask;
}

/**
 * Injectable model call for the compose step: takes the harness-built context
 * prompt and returns the raw model reply text. Kept as a plain function so the
 * harness stays testable without any LLM package or network access.
 */
export type CustomerServiceModelFn = (
  prompt: string,
  runtime?: ComposeCustomerServiceModelOutputInput,
) => Promise<string>;

/** 模型发起的一次工具调用；arguments 为原始 JSON 字符串（结构对齐 @rental/llm）。 */
export type CustomerServiceLoopToolCall = {
  id: string;
  name: string;
  arguments: string;
};

/** 循环内暴露给模型的工具定义（Chat Completions function 形态）。 */
export interface CustomerServiceToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 工具循环消息：三角色之上扩展 assistant 携带 toolCalls 与 role:'tool' 回填。 */
export type CustomerServiceLoopMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: CustomerServiceLoopToolCall[];
    }
  | { role: "tool"; toolCallId: string; content: string };

/** 有界循环的每轮模型调用（§4.1 C2）：apps/web 用 completeWithTools 实现注入。 */
export type CustomerServiceToolLoopFn = (
  messages: CustomerServiceLoopMessage[],
  tools: CustomerServiceToolDefinition[],
) => Promise<{ toolCalls: CustomerServiceLoopToolCall[] } | { text: string }>;

/** 单轮 compose 内 search_knowledge 的调用上限（§4.2 M2）：硬编码，不做配置项。 */
export const MAX_SEARCH_CALLS = 3;
// 达上限收尾指令（§4.2，兼作超额并行调用的回填）与坏参数重试提示（§4.3 层 2）
const SEARCH_BUDGET_EXHAUSTED =
  "知识库搜索次数已用完。基于以上搜索结果，直接输出 action JSON。";

export interface ComposeCustomerServiceModelOutputInput extends CreateCustomerServiceModelOutputInput {
  context: CustomerServiceContext;
  modelFn?: CustomerServiceModelFn;
  toolLoopFn?: CustomerServiceToolLoopFn;
  registry?: ToolRegistry;
  sessionStatus?: AgentSessionStatus;
  policy?: Policy;
  /** 循环中实际执行的搜索调用记录，供 harness 落 trace（红线 3：搜索必须可审计）。 */
  searchTrace?: { toolCalls: RuntimeToolCall[]; toolResults: JsonValue[] };
}

export interface ExecuteCustomerServiceActionInput {
  action: CustomerServiceAction;
  registry: ToolRegistry;
  sessionStatus?: AgentSessionStatus;
  policy?: Policy;
}

export interface RunCustomerServiceHarnessStepInput extends CustomerServiceTurnInput {
  registry: ToolRegistry;
  /** Pre-composed model output; when provided the compose step is skipped. */
  modelOutput?: string;
  /** Optional LLM compose call; absent => deterministic composer. */
  modelFn?: CustomerServiceModelFn;
  /** Optional LLM tool-loop call; present (with search_knowledge) => bounded search loop. */
  toolLoopFn?: CustomerServiceToolLoopFn;
  sessionStatus?: AgentSessionStatus;
  policy?: Policy;
  /** Production path: one task-aware Agents SDK runner. */
  sdkRunner?: CustomerServiceSdkRunner;
  runId?: string;
  signal?: AbortSignal;
  emitEvent?: (type: string, payload?: JsonValue) => void;
}

/**
 * System instructions for the LLM compose path. Constrains the model to emit
 * exactly the action JSON parseCustomerServiceOutput accepts; whatever the
 * model asks for, tool execution still passes the executor's policy gate.
 */
export const CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS = [
  "你是租赁电商的客服助手。你运行在 Chatty harness 里；harness 负责调度任务、暴露工具、执行工具、审批高风险动作和记录 trace，你只负责把当前任务和上下文合成为一个客服动作。",
  "",
  "## Harness contract",
  "1. 只处理当前这一轮输入，不要假设自己能执行未暴露的工具。",
  "2. 当前任务来自 prompt 的“当前客服任务”片段；任务边界优先级高于你的自由判断。",
  "3. 工具执行结果由 harness 回填；你必须基于已给上下文和工具结果诚实作答，不要编造。",
  "4. 如果工具或上下文没有给出确定事实，就说需要进一步确认；不要把猜测包装成确定结论。",
  "",
  "## Operating style",
  "保持清晰、务实、严谨：先解决用户当前问题，少寒暄，不夸张承诺。",
  "只在当前任务边界内行动；不要顺手扩展到没有被问到的流程、营销或售后话术。",
  "可确定的事实直接说，不确定的事实明确说需要确认；不要把“不知道”改写成看似确定的结论。",
  "当工具结果或上下文与用户说法冲突时，以工具结果和上下文为准，并用客服口吻说明需要复核。",
  "",
  "## Output contract",
  "最终只能输出一个 JSON 对象（不要 markdown 代码块、不要解释文字）：",
  '{"action": "...", "reply": "...", "toolName": "...", "toolArgs": {...}}',
  // B5 调优：DeepSeek 常在工具结果轮后、或想直接闲聊时退回普通文本作答（B4/round1 确定性
  // 回退的根因）——把"任何情况下最终都只输出 action JSON"钉死，覆盖搜索后与不搜索两种收口。
  "这条格式任何时候都成立：无论你有没有调用过工具，最终都必须、且只能输出上面那一个 JSON 对象，把要对用户说的话放进 reply 字段，绝不能直接用普通文本或纯聊天句子回复用户。",
  "action 必须是以下之一：ask_missing_info / answer_question / check_availability / recommend_size / handoff / schedule_followup。",
  "",
  "## Action contract",
  "选 action 的口径：只要用户这一轮提出了能回答的具体问题（价格、怎么租、是不是这款、政策、店铺名称电话等），就用 answer_question——哪怕你在回复里顺带追问了下一步信息也一样；只有当用户没有提出可回答的问题、你这轮纯粹在收集缺失的款式/日期/身高体重时，才用 ask_missing_info。",
  "只有当前任务是 check_availability，且上下文已经有商品、日期、尺码或身高体重时，才输出 action=check_availability，并提供 toolName=check_availability。",
  "只有当前任务是 handoff，或用户明确提出退款、投诉、人工处理、赔偿等自动化边界外事项时，才输出 action=handoff，并提供 toolName=create_handoff。",
  "只有当前任务是 follow_up，或用户明确要求提醒、稍后跟进、到期跟进时，才输出 action=schedule_followup，并提供 toolName=schedule_followup。",
  "收集顺序固定为先款式、再使用日期、再身高体重；缺身高体重时这一轮只追问身高体重（用 ask_missing_info），不要提前用 check_availability 查库存。",
  "",
  "## Tool contract",
  "search_knowledge 只用于 answer_question 任务里的事实核验：政策、费用、怎么租、计费与租期口径、售后换退、店铺信息、商品说明、尺码规则。",
  "库存档期问题不要调用 search_knowledge；用 check_availability。退款/投诉/人工问题不要调用 search_knowledge；用 create_handoff。",
  "同一个问题最多用少量精准关键词搜索；先搜最短、最可能命中的业务词，避免用“规则”“信息”这类泛词刷工具。",
  "搜索后如果没有命中具体事实，如实说明“这条规则需要进一步确认”，不要编造；如果命中了事实，用自然中文总结，不要提知识库、搜索过程或文档出处。",
  "没有明确工具结果或上下文证据时，不要说“系统会自动计算”“下单页会显示”“页面会自动生成”这类实现细节。",
  "面向用户的 reply 禁止出现这些内部词：知识库、搜索、检索、文档、上下文、tool、工具、trace、JSON。",
  "如果上下文里已经有 productId，就视为当前商品已确定；不要再问“哪一款”“商品编号是什么”，除非用户明确切换商品。",
  "",
  "## Customer reply style",
  "reply 是发给用户的中文回复：像微信聊天一样口语化、简短，两三句说完，不用 Markdown、星号、编号列表和表情符号。toolName/toolArgs 可选，仅在需要查库存（check_availability）、转人工（create_handoff）或安排跟进（schedule_followup）时给出。",
  "回答政策、费用、怎么租、计费与租期口径、售后换退、店铺信息类事实问题前，先用 search_knowledge 做事实核验；核验后仍不确定的内容，如实告诉用户需要进一步确认，不要编造。",
  // B5 调优 round6：rental-howto 稳定命中"租期"关键词——模型总把"不计入租期"改写成"不算租金"
  '解释按天计费或"怎么租"时，用"租期"这个词说清"在途时间不计入租期"，不要只说"不算租金"。',
  // B5 调优：对应金标里已验证的客服硬规则（先锁款式；记忆诚实；没听懂先致歉换说法；
  // 三项齐全直接推进不转人工）——只约束措辞与顺序，不引入任何状态机。
  "用户还没说清想租哪一款时，先只问款式或商品编号，不要同时追问身高体重。",
  "用户问自己的身高体重等资料而上下文记忆里没有记录时，如实说这边还没有记录、请用户发一下，不要编造数值。",
  '用户表示没听懂（比如只回"？"或"没听懂"）时，先道个歉再换一种更简单的说法重新解释，不要重复上一条原话，也不要催下单。',
  "款式、档期、身高体重都齐全后，直接给推荐尺码并引导用户下单、说明把租赁时间填成使用日期即可，不要转人工，也不要再追问围度或常穿码。",
  // B5 调优 round2：只用字母码——修 no-extra-questions 里 175/70 被答成"48码"数字码
  "推荐尺码只用 M、L、XL 这套字母码（按身高体重区间对应），不要用 46/48/50 这类数字西装码。",
].join("\n");

export const CUSTOMER_SERVICE_SDK_INSTRUCTIONS = [
  "你是 Chatty 的单一租赁电商客服 Agent。Chatty harness 已经确定当前任务和可用工具。",
  "只处理当前任务，不得尝试调用未暴露的工具，也不得自行改变任务类型。",
  "需要工具时必须使用当前提供的 function tool；工具结果回填后，以结果为事实依据。",
  "不要编造商品、库存、政策、工单、提醒时间或系统执行结果。",
  "最终输出必须符合结构化输出 schema，只填写发给用户的简短中文 reply。",
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
  if (mentionsAnswerableFactQuestion(question, input.event.productId)) {
    return {
      kind: "answer_question",
      goal: "回答当前客服问题，并保持下一步流程清晰",
      terminality: "reply_and_wait",
      requiredContext: ["userMessage", "recentMessages"],
      risk: "low",
    };
  }
  if (
    !input.event.productId ||
    !hasEnoughRentalContext(question, input.memory)
  ) {
    return {
      kind: "collect_missing_info",
      goal: "收集客服履约所需的商品、档期、身高体重或数量信息",
      terminality: "reply_and_wait",
      requiredContext: ["productId", "rentalPeriod", "bodyMeasurements"],
      risk: "low",
    };
  }
  return {
    kind: "answer_question",
    goal: "回答当前客服问题，并保持下一步流程清晰",
    terminality: "reply_and_wait",
    requiredContext: ["userMessage", "recentMessages"],
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
 * Parses model output into a constrained customer-service action. Invalid or
 * over-freeform output falls back to a safe answer action instead of controlling
 * tools directly.
 */
export function parseCustomerServiceOutput(raw: string): CustomerServiceAction {
  try {
    const parsed = JSON.parse(raw) as Partial<CustomerServiceAction>;
    if (
      !isCustomerServiceActionKind(parsed.action) ||
      typeof parsed.reply !== "string"
    ) {
      return fallbackAction();
    }
    return {
      action: parsed.action,
      reply: parsed.reply,
      toolName:
        typeof parsed.toolName === "string" ? parsed.toolName : undefined,
      toolArgs: isPlainJsonObject(parsed.toolArgs)
        ? parsed.toolArgs
        : undefined,
    };
  } catch {
    return fallbackAction();
  }
}

/**
 * Creates a constrained action JSON string from a scheduled customer-service
 * task. This is the deterministic composer: the default when no modelFn is
 * injected, and the fallback when the injected LLM call fails.
 */
export function createCustomerServiceModelOutput(
  input: CreateCustomerServiceModelOutputInput,
): string {
  const question = readQuestionFromEvent(input.event);
  const productId =
    input.event.productId ?? input.memory.productId ?? "general";
  const action = actionForTask(
    input.task,
    question,
    productId,
    input.event.conversationId,
  );
  return JSON.stringify(action);
}

/**
 * Compose step: answer_question 才暴露 search_knowledge 有界搜索循环（§4），
 * 库存/转人工/跟进等业务任务不把知识检索工具放进模型上下文，避免慢路径和噪音。
 * 仅 modelFn 时单发写 action JSON；两者缺席、失败或空回复一律落回确定性 composer。
 */
export async function composeCustomerServiceModelOutput(
  input: ComposeCustomerServiceModelOutputInput,
): Promise<string> {
  const { toolLoopFn, modelFn } = input;
  const searchTool = toolLoopFn && input.registry?.get("search_knowledge");
  const callModel =
    input.task.kind === "answer_question"
      ? toolLoopFn && searchTool
        ? () => runComposeSearchLoop(input, toolLoopFn, searchTool)
        : modelFn && (() => modelFn(input.context.prompt, input))
      : input.task.kind === "check_availability" && modelFn
        ? () => modelFn(input.context.prompt, input)
        : undefined;
  if (callModel) {
    const output = await callModel();
    if (output.trim().length === 0)
      throw new Error("customer-service model returned empty output");
    return output;
  }
  return createCustomerServiceModelOutput(input);
}

/**
 * §4 有界搜索循环：至多 MAX_SEARCH_CALLS 个搜索轮 + 1 个无工具收尾轮。坏参数
 * 重试同样计轮（防刷）；超出上限的并行调用不执行，以收尾文案回填（协议要求每个
 * call 有回应）。达上限后清空工具列表并注入收尾指令，强制直接输出 action JSON；
 * 仍不收敛则抛错，由 compose 落回确定性 composer。
 */
async function runComposeSearchLoop(
  input: ComposeCustomerServiceModelOutputInput,
  toolLoopFn: CustomerServiceToolLoopFn,
  searchTool: RuntimeTool,
): Promise<string> {
  const {
    name,
    description,
    parameters = { type: "object", properties: {} },
  } = searchTool;
  const tools: CustomerServiceToolDefinition[] = [
    { name, description, parameters },
  ];
  const messages: CustomerServiceLoopMessage[] = [
    { role: "system", content: CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS },
    { role: "user", content: input.context.prompt },
  ];
  let rounds = 0;
  for (let turn = 0; turn <= MAX_SEARCH_CALLS; turn += 1) {
    const reply = await toolLoopFn(
      messages,
      rounds >= MAX_SEARCH_CALLS ? [] : tools,
    );
    if ("text" in reply) return reply.text;
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: reply.toolCalls,
    });
    for (const call of reply.toolCalls) {
      rounds += 1;
      const content =
        rounds > MAX_SEARCH_CALLS
          ? SEARCH_BUDGET_EXHAUSTED
          : await runSearchCall(input, call);
      messages.push({ role: "tool", toolCallId: call.id, content });
    }
    if (rounds >= MAX_SEARCH_CALLS) {
      messages.push({ role: "user", content: SEARCH_BUDGET_EXHAUSTED });
    }
  }
  throw new Error("compose search loop did not converge to a text reply");
}

/** 循环内单次搜索：坏参数回重试提示（不触发检索）；否则过 policy 门执行，结果落 fragment 与 searchTrace。 */
async function runSearchCall(
  input: ComposeCustomerServiceModelOutputInput,
  call: CustomerServiceLoopToolCall,
): Promise<string> {
  const result = await executeSearchRequest({
    toolName: call.name,
    input: call.arguments,
    registry: input.registry as ToolRegistry,
    question: readQuestionFromEvent(input.event),
    productId: input.event.productId ?? input.memory.productId,
    searchedQueries: searchedQueries(input),
    sessionStatus: input.sessionStatus,
    policy: input.policy,
  });
  if (result.kind === "retry") return result.output;
  input.context.fragments.push(result.fragment);
  input.searchTrace?.toolCalls.push(result.toolCall);
  input.searchTrace?.toolResults.push(result.toolResult);
  return result.output;
}

/**
 * Executes a parsed customer-service action through the existing tool registry
 * and policy gate. The executor returns loop terminality, tool calls, tool
 * results, and status without running hidden side effects.
 */
export async function executeCustomerServiceAction(
  input: ExecuteCustomerServiceActionInput,
): Promise<{
  terminality: AgentStepTerminality;
  nextStatus: AgentSessionStatus;
  toolCalls: RuntimeToolCall[];
  toolResults: JsonValue[];
}> {
  if (!input.action.toolName) {
    return terminalityForAction(input.action.action);
  }

  const tool = input.registry.get(input.action.toolName);
  const args = input.action.toolArgs ?? {};
  if (!tool) {
    return {
      terminality: "handoff_and_wait",
      nextStatus: "waiting_for_human",
      toolCalls: [],
      toolResults: [
        { error: "tool_not_found", toolName: input.action.toolName },
      ],
    };
  }

  const call: RuntimeToolCall = {
    toolName: tool.name,
    arguments: args,
    risk: tool.risk,
    approvalRequired: tool.approvalRequired,
  };

  try {
    const result = await input.registry.invokeWithPolicy(
      tool.name,
      args,
      input.policy ?? createDefaultPolicy(),
      { sessionStatus: input.sessionStatus ?? "active" },
    );
    return {
      terminality: "tool_then_continue",
      nextStatus: "waiting_for_user",
      toolCalls: [call],
      toolResults: [result],
    };
  } catch (error) {
    if (
      error instanceof ApprovalRequiredError ||
      error instanceof PolicyDenyError
    ) {
      return {
        terminality: "handoff_and_wait",
        nextStatus: "waiting_for_human",
        toolCalls: [call],
        toolResults: [{ error: error.name, message: error.message }],
      };
    }
    throw error;
  }
}

/**
 * Runs one bounded customer-service harness step: schedule task, build context,
 * compose model output (injected LLM or deterministic fallback), parse it,
 * execute allowed tools, and return an inspectable trace.
 */
export async function runCustomerServiceHarnessStep(
  input: RunCustomerServiceHarnessStepInput,
): Promise<CustomerServiceHarnessStepResult> {
  const task = scheduleCustomerServiceTask(input);
  const context = buildCustomerServiceContext({ ...input, task });
  if (input.sdkRunner) {
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
  // 搜索循环调用记录收集器（无 toolLoopFn 时恒空）；搜索在前、动作工具在后合成审计记录
  const searchTrace = {
    toolCalls: [] as RuntimeToolCall[],
    toolResults: [] as JsonValue[],
  };
  const modelOutput =
    input.modelOutput ??
    (await composeCustomerServiceModelOutput({
      ...input,
      task,
      context,
      searchTrace,
    }));
  const action = parseCustomerServiceOutput(modelOutput);
  const executed = await executeCustomerServiceAction({
    action,
    registry: input.registry,
    sessionStatus: input.sessionStatus,
    policy: input.policy,
  });
  const traceId = input.event.traceId ?? input.event.eventId;
  const memoryPatch = {
    lastHarnessTask: task.kind,
    lastHarnessAction: action.action,
  } as unknown as JsonValue;

  const toolCalls = [...searchTrace.toolCalls, ...executed.toolCalls];
  const reply = replyAfterToolExecution(action, executed.toolResults);
  return {
    step: {
      sessionId: input.event.conversationId,
      traceId,
      terminality: executed.terminality,
      reply,
      toolCalls,
      nextStatus: executed.nextStatus,
      memoryPatch,
    },
    trace: {
      traceId,
      task,
      context,
      action,
      toolCalls,
      toolResults: [...searchTrace.toolResults, ...executed.toolResults],
    },
  };
}

/** Requires grounded retrieval only for policy/store facts, leaving catalog questions on auto. */
function requiresKnowledgeSearch(question: string): boolean {
  return /押金|规则|租期|计费|续租|售后|换码|换货|店名|电话|地址|营业|清洗|包邮/.test(
    question,
  );
}

function replyAfterToolExecution(
  action: CustomerServiceAction,
  toolResults: JsonValue[],
): string {
  if (action.action !== "check_availability") return action.reply;
  const result = toolResults[0];
  if (!isPlainJsonObject(result) || typeof result.available !== "boolean")
    return action.reply;

  const size =
    typeof result.suggestedSize === "string"
      ? result.suggestedSize
      : typeof result.size === "string"
        ? result.size
        : stringArg(action, "size");
  const sizeText = size ? `${size} 码` : "这个尺码";
  const startDate = stringArg(action, "startDate");
  const endDate = stringArg(action, "endDate");
  const periodText =
    startDate && endDate ? `，${startDate} 到 ${endDate} 档期` : "";

  if (result.available) {
    return `${sizeText}${periodText}可以安排。建议下单前再做一次人工复核，我也可以继续帮您确认下单信息。`;
  }
  return `${sizeText}${periodText}暂时查不到可用库存。您可以换个尺码或档期，我也可以帮您转人工复核。`;
}

function stringArg(
  action: CustomerServiceAction,
  key: string,
): string | undefined {
  const value = action.toolArgs?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function terminalityForAction(action: CustomerServiceActionKind): {
  terminality: AgentStepTerminality;
  nextStatus: AgentSessionStatus;
  toolCalls: RuntimeToolCall[];
  toolResults: JsonValue[];
} {
  if (action === "handoff") {
    return {
      terminality: "handoff_and_wait",
      nextStatus: "waiting_for_human",
      toolCalls: [],
      toolResults: [],
    };
  }
  if (action === "schedule_followup") {
    return {
      terminality: "schedule_and_wait",
      nextStatus: "waiting_for_user",
      toolCalls: [],
      toolResults: [],
    };
  }
  return {
    terminality: "reply_and_wait",
    nextStatus: "waiting_for_user",
    toolCalls: [],
    toolResults: [],
  };
}

function fallbackAction(): CustomerServiceAction {
  return {
    action: "answer_question",
    reply: "我先帮您确认一下，再继续处理。",
  };
}

function actionForTask(
  task: CustomerServiceTask,
  question: string,
  productId: string,
  conversationId: string,
): CustomerServiceAction {
  switch (task.kind) {
    case "check_availability":
      return {
        action: "check_availability",
        reply: "我先帮您查一下这个尺码和档期是否能安排。",
        toolName: "check_availability",
        toolArgs: { productId, size: extractSize(question) },
      };
    case "handoff":
      return {
        action: "handoff",
        reply: "好的，这个问题我帮您转接人工客服继续处理。",
        toolName: "create_handoff",
        toolArgs: {
          conversationId,
          reason: question.slice(0, 80) || "用户请求人工处理",
        },
      };
    case "follow_up":
      return {
        action: "schedule_followup",
        reply: "好的，我先把后续跟进事项记下来。",
        toolName: "schedule_followup",
        toolArgs: {
          conversationId,
          dueAt: resolveFollowupDueAt(question),
          reason: question.slice(0, 80),
        },
      };
    case "collect_missing_info":
      return {
        action: "ask_missing_info",
        reply:
          "您把想租的款式、使用日期、身高体重发我，我这边继续帮您对尺码和档期。",
      };
    case "answer_question":
    default:
      return {
        action: "answer_question",
        reply: "收到，我先结合当前商品和会话信息帮您确认。",
      };
  }
}

function extractSize(question: string): string {
  const match = question.toUpperCase().match(/\b(XXL|XL|L|M|S)\b/);
  return match?.[1] ?? "L";
}

/** 返回已经真正执行过的 refined query，避免并行同义 tool_calls 刷 trace。 */
function searchedQueries(
  input: ComposeCustomerServiceModelOutputInput,
): string[] {
  return (
    input.searchTrace?.toolCalls.flatMap((call) =>
      typeof call.arguments.query === "string" ? [call.arguments.query] : [],
    ) ?? []
  );
}

/** 解析 MVP 跟进时间：只处理常见相对时间，其余保留符号值，避免 LLM 猜出过期年份。 */
function resolveFollowupDueAt(question: string): string {
  const dueAt = new Date();
  if (/后天/.test(question)) {
    dueAt.setDate(dueAt.getDate() + 2);
  } else if (/明天/.test(question)) {
    dueAt.setDate(dueAt.getDate() + 1);
  } else {
    return "next_business_day";
  }
  if (/下午/.test(question)) {
    dueAt.setHours(14, 0, 0, 0);
  } else if (/上午/.test(question)) {
    dueAt.setHours(10, 0, 0, 0);
  } else {
    dueAt.setHours(9, 0, 0, 0);
  }
  return dueAt.toISOString();
}

function mentionsHandoff(question: string): boolean {
  return /投诉|退款|人工|客服|赔偿|差评/.test(question);
}

function mentionsFollowUp(question: string): boolean {
  return /提醒|跟进|到期|明天|后天|稍后/.test(question);
}

function mentionsAnswerableFactQuestion(
  question: string,
  productId?: string,
): boolean {
  if (
    /押金|规则|怎么租|如何租|流程|租期|计费|续租|售后|换码|换货|店名|电话|地址|营业/.test(
      question,
    )
  ) {
    return true;
  }
  return (
    Boolean(productId) &&
    /价格|多少钱|租金|一天|费用|尺码|材质|颜色|款式/.test(question)
  );
}

function hasRentalPeriod(question: string): boolean {
  return /\d+\s*月|\d+[/-]\d+|到|至|号|日/.test(question);
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

function isCustomerServiceActionKind(
  value: unknown,
): value is CustomerServiceActionKind {
  return (
    value === "ask_missing_info" ||
    value === "answer_question" ||
    value === "check_availability" ||
    value === "recommend_size" ||
    value === "handoff" ||
    value === "schedule_followup"
  );
}

function isPlainJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
