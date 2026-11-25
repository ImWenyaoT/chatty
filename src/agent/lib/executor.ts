/**
 * 运行主 Agent Loop，并用 Harness Evidence 校验模型草稿。
 *
 * 这个文件位于 `chatty.ts` 和 AI SDK 之间：
 *
 * 1. `prepareRequestContext()` 从 SQLite 准备模型可以参考的业务 Context；
 * 2. `generateDraft()` 让 Model 调用 Tool，并返回 `AgentDraft`；
 * 3. `finalizeReply()` 不相信草稿中的事实，重新用 Evidence 和 SQLite 校验；
 * 4. 校验成功后才返回 `Reply`，失败则统一抛出 `RecommendationError`。
 */

import {
  generateText,
  NoObjectGeneratedError,
  ToolChoiceViolationError,
  stepCountIs,
  type ModelMessage,
} from "ai";

import { Catalog, CatalogError } from "../../data/catalog.ts";
import {
  DRAFT_ACTIONS,
  type AgentDraft,
  type DraftAction,
  type RecommendationContext,
  type RecommendationRequest,
  type Reply,
  type ParsedRequest,
  type RequestContext,
} from "../../data/models.ts";
import { buildChattyAgent } from "../agent.ts";
import {
  buildDraftCorrectionAgent,
  runDraftCorrector,
} from "../subagents/draft_corrector/agent.ts";
import type { ModelProvider } from "./model-provider.ts";
import {
  EvidenceError,
  Usage,
  recordInventory,
  recordRunUsage,
  recordSearch,
  snapshotEvidence,
  validateClarificationEvidence,
  validateRecommendationEvidence,
  type RecommendationEvidence,
} from "./evidence.ts";
import { productContext } from "./framing.ts";
import {
  WorkflowStage,
  createRunContext,
  type KnowledgeScope,
} from "./context.ts";
import {
  MAX_KNOWLEDGE_CALLS_PER_SCOPE,
  allowedTools,
  knowledgeCallCount,
  renderAgentStatus,
  stageFor,
} from "./workflow.ts";

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

/** 按 ParsedRequest 的非空字段确定性准备 Context。 */
export function prepareRequestContext(
  request: ParsedRequest,
  userId: string,
  catalog: Catalog,
  evidence: RecommendationEvidence,
): RequestContext {
  let recommendation: RecommendationContext | null = null;
  if (request.product_need !== null) {
    // ProductNeed 使用“元”，Catalog 使用“分”；productContext() 负责转换单位。
    const recommendationRequest: RecommendationRequest = {
      user_id: userId,
      num_items: 3,
      context: productContext(request.product_need),
    };
    recommendation = prepareRecommendationContext(
      recommendationRequest,
      catalog,
      evidence,
    );
  }

  // 纯知识问答不需要营销策略，只需要知识检索。
  if (recommendation === null)
    evidence.required_support_tools = ["retrieve_knowledge"];

  // scope 告诉 Evidence：本轮必须完成通用知识、商品知识，或者两者都完成。
  const scopes: KnowledgeScope[] = [];
  if (request.knowledge_query !== null) scopes.push("general");
  if (request.product_need !== null) scopes.push("product");
  evidence.required_knowledge_scopes = scopes;

  // 有商品需求就不能用 answer 收尾，哪怕同时还有知识问题——混合请求把答案写进
  // recommend 的 answer 字段。这里的判据必须和 finalizeReply 的分支完全一致。
  evidence.allowed_final_actions =
    recommendation === null ? ["answer"] : ["recommend", "clarify"];

  return { request, recommendation };
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

/**
 * 把 Harness 算出的允许 action 收窄成 Zod enum 能吃的非空元组。
 *
 * 返回类型 `[DraftAction, ...DraftAction[]]` 读作「至少有一个元素的数组」：
 * 第一项是 DraftAction，后面 `...` 表示还可以有任意多个同类型的。Zod 的 enum()
 * 要求至少一个取值，普通的 `DraftAction[]`（可能是空数组）满足不了它。
 */
function narrowActions(
  evidence: RecommendationEvidence,
): readonly [DraftAction, ...DraftAction[]] {
  const allowed = evidence.allowed_final_actions.filter(
    // `(action): action is DraftAction =>` 叫类型谓词。普通的 filter 过滤完，
    // TypeScript 仍然认为元素是 string；写成类型谓词就是在告诉它
    // 「凡是通过这个函数的，类型就是 DraftAction」，后面才不用再断言。
    (action): action is DraftAction =>
      (DRAFT_ACTIONS as readonly string[]).includes(action),
  );
  // 空集合意味着 RequestContext 没准备好；此时不收窄，交给既有校验报错。
  return allowed.length === 0
    ? DRAFT_ACTIONS
    : (allowed as [DraftAction, ...DraftAction[]]);
}

/** 主 Agent Loop 的执行器；公开方法只有 `respond()`。 */
export class ChattyExecutor {
  // 字段名前的 # 是 JavaScript 的私有字段，类外面拿不到，也不是 TS 特有语法。
  // readonly 则是 TS 的：构造完就不能再赋值。
  readonly #catalog: Catalog;
  readonly #provider: ModelProvider;

  constructor(catalog: Catalog, provider: ModelProvider) {
    this.#catalog = catalog;
    this.#provider = provider;
  }

  /** 先生成 Model 草稿，再用确定性代码把草稿收敛为 Reply。 */
  async respond(
    requestContext: RequestContext,
    evidence: RecommendationEvidence,
    userText: string,
    history: readonly ModelMessage[] = [],
  ): Promise<Reply> {
    try {
      // draft 仍然只是 Model 的提议，不能直接返回给用户。
      const draft = await this.#generateDraft(
        requestContext,
        evidence,
        userText,
        history,
      );
      // finalize 是信任边界：只有通过 Evidence 和 SQLite 校验才能成为 Reply。
      return this.#finalizeReply(requestContext, evidence, draft);
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
    requestContext: RequestContext,
    evidence: RecommendationEvidence,
    userText: string,
    history: readonly ModelMessage[],
  ): Promise<AgentDraft> {
    // 纯知识问答没有 recommendation，因此 request 可以是 null。
    const request = requestContext.recommendation?.request ?? null;
    // RunContext 是一次 Agent Loop 的共享运行时对象。
    // Tool Result 返回 Model；Evidence 留在 RunContext，仅供 Harness 校验。
    const runContext = createRunContext(request, this.#catalog, evidence);
    const agent = buildChattyAgent(this.#provider, narrowActions(evidence));
    const toolsContext = {
      retrieve_knowledge: runContext,
      get_marketing_strategy: runContext,
    };
    const runUsage = new Usage();

    try {
      const result = await generateText({
        model: agent.model,
        instructions: agent.instructions,
        messages: buildModelInput(requestContext, userText, history),
        allowSystemInMessages: true,
        tools: agent.tools,
        toolsContext,
        output: agent.output,
        stopWhen: stepCountIs(12),
        toolCallConcurrency: 1,
        maxRetries: 0,
        prepareStep: ({ messages }) => {
          // 批次边界：上一批 Tool 已结束，下一批按最新 Evidence 重新冻结。
          runContext.batch = null;
          const stage = stageFor(evidence);
          const nextTools = allowedTools(evidence);
          return {
            messages: [
              ...messages,
              { role: "system", content: renderAgentStatus(evidence) },
            ],
            toolChoice:
              stage === WorkflowStage.NEED_SUPPORT && nextTools.length > 0
                ? "required"
                : "auto",
            activeTools: nextTools as Array<
              "retrieve_knowledge" | "get_marketing_strategy"
            >,
          };
        },
        onStepFinish: (step) => {
          runUsage.add(Usage.fromAiSdk(step.usage, 1));
        },
      });
      recordRunUsage(evidence, runUsage);
      return result.output as AgentDraft;
    } catch (error) {
      recordRunUsage(evidence, runUsage);
      const rawText = extractRecoverableDraftText(error);
      if (rawText === null) throw error;
      // 违规/不合规响应也算一次 Model 请求；onStepFinish 可能尚未记入。
      if (runUsage.requests === 0) {
        recordRunUsage(evidence, new Usage({ requests: 1 }));
      }
      // 纠正过程也调用了 Model，不能在统计里悄悄漏掉这次费用。
      try {
        const corrected = await runDraftCorrector(
          buildDraftCorrectionAgent(this.#provider, narrowActions(evidence)),
          rawText,
        );
        recordRunUsage(evidence, corrected.usage);
        return corrected.output;
      } catch (correctionError) {
        throw new RecommendationError("invalid_draft", {
          reason: "correction_agent_rejected",
          cause:
            correctionError instanceof Error
              ? correctionError.message
              : String(correctionError),
        });
      }
    }
  }

  /** 用 Harness Evidence 和 SQLite 把模型草稿收敛为领域 Reply。 */
  #finalizeReply(
    requestContext: RequestContext,
    evidence: RecommendationEvidence,
    draft: AgentDraft,
  ): Reply {
    const recommendation = requestContext.recommendation;
    validateKnowledgeAnswer(
      requestContext,
      evidence,
      draft.answer,
      draft.action,
    );

    // 路径 1：只有知识问答时才能直接 answer；商品请求不能借此绕过推荐校验。
    if (draft.action === "answer") {
      if (
        requestContext.request.knowledge_query === null ||
        recommendation !== null ||
        draft.answer === null
      ) {
        throw new RecommendationError("invalid_draft", {
          reason: "answer_action_not_allowed",
          draft_action: draft.action,
          has_knowledge_query: requestContext.request.knowledge_query !== null,
          has_product_request: recommendation !== null,
          answer_present: draft.answer !== null,
        });
      }
      return { kind: "answer", answer: draft.answer };
    }

    // 路径 2：只有存在商品需求时才能 clarify，并且必需 Tool 仍要执行完。
    if (draft.action === "clarify") {
      if (recommendation === null || draft.question === null) {
        throw new RecommendationError("invalid_draft", {
          reason: "clarify_not_allowed",
          draft_action: draft.action,
          has_product_request: recommendation !== null,
          question_present: draft.question !== null,
        });
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
      throw new RecommendationError("invalid_draft", {
        reason: "recommend_not_allowed",
        draft_action: draft.action,
        has_product_request: recommendation !== null,
        recommendations_present: draft.recommendations !== null,
      });
    }
    validateRecommendationEvidence(evidence, draft.recommendations);
    if (evidence.profile === null)
      throw new RecommendationError("profile_not_loaded");

    // Evidence 校验集合关系，Catalog.finalize 再从 SQLite 读取最终价格和库存。
    const finalizedRequest = recommendation.request;
    const products = this.#catalog.finalize(
      draft.recommendations,
      finalizedRequest,
      evidence.profile,
    );
    // 只有成功推荐后才更新画像；回答、澄清和失败都不会写入偏好。
    this.#catalog.updateUserProfileAfterSuccess(
      finalizedRequest.user_id,
      finalizedRequest.context.preferred_categories ?? [],
    );
    return { kind: "recommend", products, answer: draft.answer };
  }
}

/**
 * 从结构化输出失败或 toolChoice 违规中取出可交给 draft_corrector 的文本。
 *
 * AI SDK 在 toolChoice=required 时若模型直接吐文本会抛 ToolChoiceViolationError；
 * 旧 Agents SDK 则会走 invalidFinalOutput。两条路径都收敛到同一次纠正。
 */
function extractRecoverableDraftText(error: unknown): string | null {
  if (NoObjectGeneratedError.isInstance(error)) {
    return error.text ?? "";
  }
  if (ToolChoiceViolationError.isInstance(error)) {
    return error.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("");
  }
  return null;
}

/** 保留用户原话，并把 Harness Context 作为独立来源注入。 */
function buildModelInput(
  requestContext: RequestContext,
  userText: string,
  history: readonly ModelMessage[],
): ModelMessage[] {
  return [
    ...history,
    // 用户消息保留原话，Model 可以看到自然语言细节。
    { role: "user", content: userText },
    // Harness Context 使用 system role，明确它比用户描述更可信。
    {
      role: "system",
      content: `<harness_context>\n${JSON.stringify(requestContext)}\n</harness_context>`,
    },
  ];
}

/** 知识问题必须有回答，并且 Evidence 必须记录到真实检索命中。 */
function validateKnowledgeAnswer(
  requestContext: RequestContext,
  evidence: RecommendationEvidence,
  answer: string | null,
  draftAction: string,
): void {
  // 没有知识问题时，这项校验与本轮无关。
  if (requestContext.request.knowledge_query === null) return;
  // 混合请求最常见的失败：模型给了商品推荐，却把知识问题的 answer 留空。
  if (!answer)
    throw new RecommendationError("invalid_draft", {
      reason: "knowledge_answer_missing",
      draft_action: draftAction,
    });
  // 检索一条都没命中时，提示词明确允许模型"说明没有查到"——这条出口不能被堵死，
  // 否则 Harness 就在否决自己允许的行为。只有在还能继续检索时才判死：
  // 那种情况说明模型没用完机会就下结论。
  const generalCalls = knowledgeCallCount(evidence, "general");
  const exhausted = generalCalls >= MAX_KNOWLEDGE_CALLS_PER_SCOPE;
  if (evidence.general_knowledge_hits === 0 && !exhausted) {
    throw new RecommendationError("knowledge_not_retrieved", {
      reason: "answered_without_retrieval",
      knowledge_calls: generalCalls,
    });
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
