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
  extractAllTextOutput,
  run,
  type AgentInputItem,
  type RunErrorHandlerInput,
  type RunErrorHandlerResult,
} from "@openai/agents";

import { Catalog, CatalogError } from "../../data/catalog.ts";
import {
  type AgentDraft,
  type RecommendationContext,
  type RecommendationRequest,
  type Reply,
  type TaskContext,
  type TaskFrame,
} from "../../data/models.ts";
import { buildChattyAgent, type ChattyAgentType } from "../agent.ts";
import { buildDraftCorrectionAgent } from "../subagents/draft_corrector/agent.ts";
import type { ModelProvider } from "./model-provider.ts";
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
import { stableStringify } from "./tools.ts";
import { appendAgentStatus } from "./workflow.ts";

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

  // 有商品需求就不能用 answer 收尾，哪怕同时还有知识问题——混合请求把答案写进
  // recommend 的 answer 字段。这里的判据必须和 finalizeReply 的分支完全一致。
  evidence.allowed_final_actions =
    recommendation === null ? ["answer"] : ["recommend", "clarify"];

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
