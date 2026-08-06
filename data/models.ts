/**
 * Chatty 业务对象。
 *
 * 模型只描述数据形状，不包含数据库查询或 Agent 流程。
 *
 * schema 负责运行时校验，`z.infer` 提供静态类型。
 * 字段名保持 snake_case，因为它们同时是 SQLite 列名、种子数据键名和 HTTP 契约字段。
 */

import { z } from "zod";

export const USER_SEGMENTS = [
  "new_user",
  "active",
  "high_value",
  "price_sensitive",
  "churn_risk",
] as const;

export const userSegmentSchema = z.enum(USER_SEGMENTS);
export type UserSegment = z.infer<typeof userSegmentSchema>;

export const productSchema = z.object({
  product_id: z.string(),
  name: z.string(),
  category: z.string(),
  price_cents: z.number().int(),
  description: z.string(),
  brand: z.string(),
  seller_id: z.string(),
  stock: z.number().int(),
  tags: z.array(z.string()),
  popularity_score: z.number(),
  image_url: z.string(),
  source: z.string(),
});
export type Product = z.infer<typeof productSchema>;

export const userContextSchema = z.object({
  recent_views: z.array(z.string()).nullable().default(null),
  recent_purchases: z.array(z.string()).nullable().default(null),
  preferred_categories: z.array(z.string()).nullable().default(null),
  min_price_cents: z.number().int().nullable().default(null),
  max_price_cents: z.number().int().nullable().default(null),
});
export type UserContext = z.infer<typeof userContextSchema>;

export function emptyUserContext(): UserContext {
  return userContextSchema.parse({});
}

/** 用户明确表达的商品约束；字段为空仍表示用户正在找商品。 */
export const productNeedSchema = z.object({
  category: z.string().nullable().default(null),
  min_yuan: z.number().min(0).nullable().default(null),
  max_yuan: z.number().min(0).nullable().default(null),
});
export type ProductNeed = z.infer<typeof productNeedSchema>;

export type TaskFrame = {
  product_need: ProductNeed | null;
  knowledge_query: string | null;
};

/** Harness 使用的领域形状；不直接作为 provider structured output。 */
export const taskFrameSchema = z
  .object({
    product_need: productNeedSchema.nullable().default(null),
    knowledge_query: z.string().nullable().default(null),
  })
  .transform((frame): TaskFrame => ({
    product_need: frame.product_need,
    knowledge_query: frame.knowledge_query?.trim() || null,
  }))
  .refine(
    (frame) => frame.product_need !== null || frame.knowledge_query !== null,
    {
      error: "empty_task_frame",
    },
  );

export const userProfileSchema = z.object({
  user_id: z.string(),
  segment: userSegmentSchema,
  preferred_categories: z.array(z.string()),
  min_price_cents: z.number().int(),
  max_price_cents: z.number().int(),
  recent_views: z.array(z.string()),
  recent_purchases: z.array(z.string()),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const knowledgeDocumentSchema = z.object({
  doc_id: z.string(),
  title: z.string(),
  content: z.string(),
  category: z.string(),
  product_id: z.string().nullable(),
  source: z.string(),
});
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const knowledgeHitSchema = knowledgeDocumentSchema.extend({
  chunk_ordinal: z.number().int(),
  relevance_score: z.number(),
});
export type KnowledgeHit = z.infer<typeof knowledgeHitSchema>;

export const marketingStrategySchema = z.object({
  segment: userSegmentSchema,
  tone: z.string(),
  instructions: z.string(),
  forbidden_words: z.array(z.string()),
});
export type MarketingStrategy = z.infer<typeof marketingStrategySchema>;

export const recommendationDraftItemSchema = z.object({
  product_id: z.string(),
  reason: z.string(),
  marketing_copy: z.string(),
});
export type RecommendationDraftItem = z.infer<
  typeof recommendationDraftItemSchema
>;

export const recommendationRequestSchema = z.object({
  user_id: z.string(),
  num_items: z.number().int().min(1).max(10).default(5),
  context: userContextSchema.default(() => emptyUserContext()),
});
export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;

/** Harness 在进入 Model 前确定的画像、候选商品和在售商品。 */
export type RecommendationContext = {
  request: RecommendationRequest;
  profile: UserProfile;
  candidates: Product[];
  inventory: Product[];
};

/** 进入主 Agent Loop 前已经准备好的全部业务 Context。 */
export type TaskContext = {
  frame: TaskFrame;
  recommendation: RecommendationContext | null;
};

export const recommendedProductSchema = z.object({
  product_id: z.string(),
  name: z.string(),
  category: z.string(),
  price_cents: z.number().int(),
  brand: z.string(),
  stock: z.number().int(),
  tags: z.array(z.string()),
  low_stock: z.boolean(),
  reason: z.string(),
  marketing_copy: z.string(),
});
export type RecommendedProduct = z.infer<typeof recommendedProductSchema>;

export const DRAFT_ACTIONS = ["answer", "clarify", "recommend"] as const;
export type DraftAction = (typeof DRAFT_ACTIONS)[number];

/**
 * 模型生成的草稿；Harness 仍会在之后验证其中的商品。
 *
 * action 的取值范围是参数：本轮存在商品需求时收窄成 recommend / clarify，让模型**发不出**
 * answer，而不是发出来再被拒。这是「约束优先于指导」在输出契约上的执行——提示词说明与
 * 状态栏结论仍然保留，三者互补。
 */
export function buildAgentDraftSchema(
  actions: readonly [DraftAction, ...DraftAction[]] = DRAFT_ACTIONS,
) {
  return z
    .object({
      action: z.enum(actions),
      answer: z.string().nullable().default(null),
      question: z.string().nullable().default(null),
      recommendations: z
        .array(recommendationDraftItemSchema)
        .nullable()
        .default(null),
    })
    .superRefine((draft, ctx) => {
      const fail = (error: string) => ctx.addIssue({ code: "custom", error });
      if (draft.action === "answer") {
        if (!draft.answer?.trim()) fail("answer_required");
        if (draft.question || draft.recommendations?.length) {
          fail("answer_must_not_include_product_payload");
        }
      }
      if (draft.action === "clarify") {
        if (!draft.question?.trim()) fail("clarify_question_required");
        if (draft.recommendations?.length) fail("clarify_must_not_recommend");
      }
      if (draft.action === "recommend") {
        if (!draft.recommendations?.length) fail("recommendations_required");
        if (draft.question) fail("recommend_must_not_ask_question");
      }
    });
}

/** 全量 action 的草稿契约；draft_corrector 与测试用它。 */
export const agentDraftSchema = buildAgentDraftSchema();
export type AgentDraft = z.infer<ReturnType<typeof buildAgentDraftSchema>>;

export type RecommendationResponse = {
  kind: "recommend";
  products: RecommendedProduct[];
  answer: string | null;
};

export type ClarifyReply = {
  kind: "clarify";
  question: string;
  answer: string | null;
};

export type KnowledgeReply = {
  kind: "answer";
  answer: string;
};

/** 三种 Reply 通过 `kind` 组成判别联合。 */
export type Reply = RecommendationResponse | ClarifyReply | KnowledgeReply;
