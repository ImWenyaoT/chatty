/**
 * 运行主 Agent Loop，并用 Harness Evidence 校验模型草稿。
 *
 * 这个文件位于 `chatty.ts` 和 Agents SDK 之间：
 *
 * 1. `prepareTaskContext()` 从 SQLite 准备模型可以参考的业务 Context；
 * 2. `generateDraft()` 让 Model 调用 Tool，并返回 `AgentDraft`；
 * 3. `finalizeReply()` 不相信草稿中的事实，重新用 Evidence 和 SQLite 校验；
 * 4. 校验成功后才返回 `Reply`，失败则统一抛出 `RecommendationError`。
 */

import {
  Agent,
  extractAllTextOutput,
  run,
  type AgentInputItem,
  type RunErrorHandlerInput,
  type RunErrorHandlerResult,
} from "@openai/agents";

import { Catalog, CatalogError } from "../data/catalog.ts";
import {
  agentDraftSchema,
  type AgentDraft,
  type RecommendationContext,
  type RecommendationRequest,
  type Reply,
  type TaskContext,
  type TaskFrame,
} from "../data/models.ts";
import type { ModelProvider } from "../model-provider.ts";
import {
  EvidenceError,
  guardRepeatedCall,
  recordInventory,
  recordRunUsage,
  recordSearch,
  snapshotEvidence,
  validateClarificationEvidence,
  validateRecommendationEvidence,
  type RecommendationEvidence,
} from "./evidence.ts";
import { productContext } from "./framing.ts";
import { createRunContext, type ChattyRunContext } from "./context.ts";
import { CHATTY_TOOLS, stableStringify } from "./tools.ts";
import { appendAgentStatus } from "./workflow.ts";

const INSTRUCTIONS = `你是 Chatty，一个电商推荐与知识问答 Single Agent。

Harness 已按 TaskFrame 的非空字段准备 TaskContext，但不会提前检索知识。
knowledge_query 非空时，调用 retrieve_knowledge(scope="general")；观察结果后，
信息不足可以改写 query 再检索，最多检索三次，没有依据时明确说明没有查到。
recommendation 非空时，必须调用 retrieve_knowledge(scope="product") 与
get_marketing_strategy。混合请求需要分别检索 general 与 product。
不能在中途输出进度。

只推荐经过搜索、库存检查和知识检索支撑的商品。
价格与库存只采用 RecommendationContext，不得编造商品、优惠或折扣。
完成当前请求所需的 Tool，且知识充分后停止调用 Tool。
商品推荐输出：
{"action":"recommend","answer":"知识问题答案或 null",
"recommendations":[{"product_id":"商品ID","reason":"推荐理由",
"marketing_copy":"营销文案"}]}
只有知识问答时输出：{"action":"answer","answer":"有依据的答案"}
如果 candidates 为空，澄清时只能说当前条件下没有匹配商品，不能说缺货。
如果 candidates 非空但 inventory 为空，才可以说候选商品无库存。
两种情况都要先完成知识检索与营销策略；不要反复尝试同一预算。
需要澄清商品条件时才输出：
{"action":"clarify","question":"问题","answer":"知识问题答案或 null"}

每轮末尾的 <agent_status> 由 Harness 根据真实执行状态生成。
只调用 allowed_next 列出的 Tool；blocked 表示调用未执行，应按 required_next 纠正。
`;

/** 由 Harness 一次完成不需要 Model 判断的画像、搜索和库存步骤。 */
export function prepareRecommendationContext(
  request: RecommendationRequest,
  catalog: Catalog,
  evidence: RecommendationEvidence,
): RecommendationContext {
  // profile 是根据 user_id、历史画像和本轮明确条件合并出的当前用户画像。
  const profile = catalog.userProfile(request.user_id, request.context);

  // Evidence 是 Harness 自己的账本。记录 profile 后，Model 不能声称没执行过的步骤。
  evidence.profile = profile;
  evidence.used_tools.push("get_user_profile");

  guardRepeatedCall(evidence, "search_products", stableStringify(request));

  // candidates 包含符合画像和预算的候选商品，此时还没有确认库存。
  const candidates = catalog.search({
    profile,
    categories: profile.preferred_categories,
    minPriceCents: profile.min_price_cents,
    maxPriceCents: profile.max_price_cents,
    limit: 10,
  });
  recordSearch(
    evidence,
    candidates.map((product) => product.product_id),
  );

  // inventory 只保留 candidates 中当前库存大于零的商品。
  const inventory = catalog.inventory(evidence.recalled_product_order);
  recordInventory(
    evidence,
    inventory.map((product) => product.product_id),
  );
  return { request, profile, candidates, inventory };
}

/** 按 TaskFrame 的非空字段确定性准备 Context。 */
export function prepareTaskContext(
  frame: TaskFrame,
  userId: string,
  catalog: Catalog,
  evidence: RecommendationEvidence,
): TaskContext {
  let recommendation: RecommendationContext | null = null;
  if (frame.product_need !== null) {
    // ProductNeed 使用“元”，Catalog 使用“分”；productContext() 负责转换单位。
    const request: RecommendationRequest = {
      user_id: userId,
      num_items: 3,
      context: productContext(frame.product_need),
    };
    recommendation = prepareRecommendationContext(request, catalog, evidence);
  }

  // 纯知识问答不需要营销策略，只需要知识检索。
  if (recommendation === null)
    evidence.required_support_tools = ["retrieve_knowledge"];

  // scope 告诉 Evidence：本轮必须完成通用知识、商品知识，或者两者都完成。
  const scopes: string[] = [];
  if (frame.knowledge_query !== null) scopes.push("general");
  if (frame.product_need !== null) scopes.push("product");
  evidence.required_knowledge_scopes = scopes;

  return { frame, recommendation };
}

/** Executor 对外的稳定失败类型，code 给 HTTP 层，diagnostics 给日志。 */
export class RecommendationError extends Error {
  readonly code: string;
  readonly diagnostics: Record<string, unknown>;

  constructor(code: string, diagnostics: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** 使用 Agents SDK 声明 Chatty 的 Model、Tool 与结构化输出契约。 */
export function buildChattyAgent(provider: ModelProvider) {
  return new Agent<ChattyRunContext, typeof agentDraftSchema>({
    name: "Chatty",
    instructions: INSTRUCTIONS,
    model: provider.agentModel,
    tools: CHATTY_TOOLS,
    // SDK 会把最终输出交给 Zod，运行时验证是否符合 AgentDraft。
    outputType: agentDraftSchema,
    // toolChoice="required" 强制第一轮先调用 Tool，不能跳过事实准备直接生成答案。
    modelSettings: { toolChoice: "required", reasoning: { effort: "none" } },
    resetToolChoice: true,
  });
}

export type ChattyAgentType = ReturnType<typeof buildChattyAgent>;

/** 把 provider 未遵守 Schema 的最终文本纠正为同一个结构化契约。 */
function buildDraftCorrectionAgent(provider: ModelProvider) {
  return new Agent({
    name: "Chatty Draft Corrector",
    instructions:
      "把输入改写为指定的结构化输出。只保留输入已有事实，不增加商品、优惠或折扣。",
    model: provider.agentModel,
    outputType: agentDraftSchema,
    modelSettings: { reasoning: { effort: "none" } },
  });
}

/** 读取失败响应中的文本，执行一次受限纠正，并把 Usage 计入主流程。 */
async function correctInvalidDraft(
  data: RunErrorHandlerInput<ChattyRunContext, ChattyAgentType>,
  provider: ModelProvider,
): Promise<RunErrorHandlerResult<ChattyAgentType>> {
  const corrected = await run(
    buildDraftCorrectionAgent(provider),
    extractAllTextOutput(data.runData.newItems),
    { maxTurns: 1 },
  );
  // 纠正过程也调用了 Model，不能在统计里悄悄漏掉这次费用。
  data.context.context.evidence.usage.add(corrected.state.usage);
  if (corrected.finalOutput === undefined) {
    throw new RecommendationError("invalid_draft");
  }
  return { finalOutput: corrected.finalOutput };
}

/** 主 Agent Loop 的执行器；公开方法只有 `respond()`。 */
export class ChattyExecutor {
  readonly #catalog: Catalog;
  readonly #provider: ModelProvider;

  constructor(catalog: Catalog, provider: ModelProvider) {
    this.#catalog = catalog;
    this.#provider = provider;
  }

  /** 先生成 Model 草稿，再用确定性代码把草稿收敛为 Reply。 */
  async respond(
    taskContext: TaskContext,
    evidence: RecommendationEvidence,
    userText: string,
    history: readonly AgentInputItem[] = [],
  ): Promise<Reply> {
    try {
      // draft 仍然只是 Model 的提议，不能直接返回给用户。
      const draft = await this.#generateDraft(
        taskContext,
        evidence,
        userText,
        history,
      );
      // finalize 是信任边界：只有通过 Evidence 和 SQLite 校验才能成为 Reply。
      return this.#finalizeReply(taskContext, evidence, draft);
    } catch (error) {
      // 把不同来源的失败统一成 RecommendationError；cause 保留原始异常链。
      if (error instanceof RecommendationError) {
        throw new RecommendationError(error.code, {
          ...diagnostics(evidence, error),
          ...error.diagnostics,
        });
      }
      if (error instanceof EvidenceError) {
        // missing/detail 是 Evidence 校验特有的定位信息。
        throw new RecommendationError(error.code, {
          ...diagnostics(evidence, error),
          missing: error.missing,
          detail: error.detail,
        });
      }
      // CatalogError 的消息本身就是稳定业务错误码。
      if (error instanceof CatalogError) {
        throw new RecommendationError(
          error.message,
          diagnostics(evidence, error),
        );
      }
      // Tool 或 SDK 的未知异常不能穿透 HTTP 层成为无结构的 500。
      throw new RecommendationError(
        "recommendation_failed",
        diagnostics(evidence, error),
      );
    }
  }

  /** 运行主 Agent Loop；此阶段只产出草稿，不返回用户结果。 */
  async #generateDraft(
    taskContext: TaskContext,
    evidence: RecommendationEvidence,
    userText: string,
    history: readonly AgentInputItem[],
  ): Promise<AgentDraft> {
    // 纯知识问答没有 recommendation，因此 request 可以是 null。
    const request = taskContext.recommendation?.request ?? null;
    // RunContext 是一次 Agent Loop 的共享运行时对象。
    // Tool Result 返回 Model；Evidence 留在 RunContext，仅供 Harness 校验。
    const runContext = createRunContext(request, this.#catalog, evidence);

    const result = await run(
      buildChattyAgent(this.#provider),
      buildModelInput(taskContext, userText, history),
      {
        context: runContext,
        // 一个 turn 指一次 Model 请求，不是一次用户对话。Tool Loop 最多 12 次。
        maxTurns: 12,
        // 每次调用 Model 前，都根据最新 Evidence 追加 agent_status。
        callModelInputFilter: appendAgentStatus,
        // Tool 串行执行，保证后一个 Tool 看见前一个 Tool 写入的 Evidence。
        toolExecution: { maxFunctionToolConcurrency: 1 },
        // 如果最终 JSON 不符合 AgentDraft，SDK 会调用这个纠正函数一次。
        errorHandlers: {
          invalidFinalOutput: (data) =>
            correctInvalidDraft(data, this.#provider),
        },
      },
    );
    recordRunUsage(evidence, result.state.usage);
    if (result.finalOutput === undefined)
      throw new RecommendationError("invalid_draft");
    return result.finalOutput;
  }

  /** 用 Harness Evidence 和 SQLite 把模型草稿收敛为领域 Reply。 */
  #finalizeReply(
    taskContext: TaskContext,
    evidence: RecommendationEvidence,
    draft: AgentDraft,
  ): Reply {
    const recommendation = taskContext.recommendation;
    validateKnowledgeAnswer(taskContext, evidence, draft.answer);

    // 路径 1：只有知识问答时才能直接 answer；商品请求不能借此绕过推荐校验。
    if (draft.action === "answer") {
      if (
        taskContext.frame.knowledge_query === null ||
        recommendation !== null ||
        draft.answer === null
      ) {
        throw new RecommendationError("invalid_draft");
      }
      return { kind: "answer", answer: draft.answer };
    }

    // 路径 2：只有存在商品需求时才能 clarify，并且必需 Tool 仍要执行完。
    if (draft.action === "clarify") {
      if (recommendation === null || draft.question === null) {
        throw new RecommendationError("invalid_draft");
      }
      validateClarificationEvidence(evidence);
      return {
        kind: "clarify",
        question: draft.question,
        answer: draft.answer,
      };
    }

    // 路径 3：剩下的是 recommend。必须同时有 Harness Context 和 Model 推荐项。
    if (recommendation === null || draft.recommendations === null) {
      throw new RecommendationError("invalid_draft");
    }
    validateRecommendationEvidence(evidence, draft.recommendations);
    if (evidence.profile === null)
      throw new RecommendationError("profile_not_loaded");

    // Evidence 校验集合关系，Catalog.finalize 再从 SQLite 读取最终价格和库存。
    const request = recommendation.request;
    const products = this.#catalog.finalize(
      draft.recommendations,
      request,
      evidence.profile,
    );
    // 只有成功推荐后才更新画像；回答、澄清和失败都不会写入偏好。
    this.#catalog.updateUserProfileAfterSuccess(
      request.user_id,
      request.context.preferred_categories ?? [],
    );
    return { kind: "recommend", products, answer: draft.answer };
  }
}

/** 保留用户原话，并把 Harness Context 作为独立来源注入。 */
function buildModelInput(
  taskContext: TaskContext,
  userText: string,
  history: readonly AgentInputItem[],
): AgentInputItem[] {
  return [
    ...history,
    // 用户消息保留原话，Model 可以看到自然语言细节。
    { role: "user", content: [{ type: "input_text", text: userText }] },
    // Harness Context 使用 system role，明确它比用户描述更可信。
    {
      role: "system",
      content: `<harness_context>\n${JSON.stringify(taskContext)}\n</harness_context>`,
    },
  ];
}

/** 知识问题必须有回答，并且 Evidence 必须记录到真实检索命中。 */
function validateKnowledgeAnswer(
  taskContext: TaskContext,
  evidence: RecommendationEvidence,
  answer: string | null,
): void {
  // 没有知识问题时，这项校验与本轮无关。
  if (taskContext.frame.knowledge_query === null) return;
  if (!answer) throw new RecommendationError("invalid_draft");
  if (evidence.general_knowledge_hits === 0) {
    throw new RecommendationError("knowledge_not_retrieved");
  }
}

/** 保留异常类型与消息，避免空消息异常在日志中变成无声失败。 */
function diagnostics(
  evidence: RecommendationEvidence,
  error: unknown,
): Record<string, unknown> {
  return {
    evidence: snapshotEvidence(evidence),
    cause_type: error instanceof Error ? error.constructor.name : typeof error,
    cause: error instanceof Error ? error.message : String(error),
  };
}
