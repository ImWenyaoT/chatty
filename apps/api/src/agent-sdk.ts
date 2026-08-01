import {
  Agent,
  OpenAIProvider,
  RunContext,
  Runner,
  tool,
  type AgentInputItem,
  type ModelProvider,
} from "@openai/agents";
import { z } from "zod";

import {
  createEvidence,
  recordInventory,
  recordKnowledge,
  recordSearch,
  type RecommendationEvidence,
} from "./tools.js";
import type { KnowledgeHit, UserProfile } from "./types.js";

export const CHATTY_TOOL_NAMES = [
  "get_user_profile",
  "search_products",
  "check_inventory",
  "retrieve_knowledge",
  "get_marketing_strategy",
] as const;

export type ChattyToolName = (typeof CHATTY_TOOL_NAMES)[number];

export interface RecommendationRequest {
  userId: string;
  numItems: number;
  context: {
    preferredCategories: string[];
    minPriceCents?: number;
    maxPriceCents?: number;
  };
}

/**
 * Tool 的两个 context out：model 进入下一轮模型上下文；evidence 只写入 Harness。
 * 适配 SQLite 的实现负责同时返回两者，Agent SDK tool 只把 model 序列化给模型。
 */
export interface HarnessToolResult<TModel, TEvidence> {
  model: TModel;
  evidence: TEvidence;
}

export interface ChattyToolHandlers {
  getUserProfile(
    request: RecommendationRequest,
  ): Promise<HarnessToolResult<unknown, { profile: UserProfile }>>;
  searchProducts(
    request: RecommendationRequest,
    input: {
      categories: string[];
      minPriceCents: number;
      maxPriceCents: number;
      tags: string[];
      limit: number;
    },
  ): Promise<HarnessToolResult<unknown, { productIds: string[] }>>;
  checkInventory(
    request: RecommendationRequest,
    input: { productIds: string[] },
  ): Promise<HarnessToolResult<unknown, { productIds: string[] }>>;
  retrieveKnowledge(
    request: RecommendationRequest,
    input: {
      query: string;
      categories: string[];
      productIds: string[];
      limit: number;
    },
  ): Promise<
    HarnessToolResult<
      unknown,
      { hits: KnowledgeHit[]; groundedProductIds: string[] }
    >
  >;
  getMarketingStrategy(
    request: RecommendationRequest,
    input: { segment: string },
  ): Promise<HarnessToolResult<unknown, Record<string, never>>>;
}

export interface ChattyRunContext {
  readonly request: RecommendationRequest;
  readonly handlers: ChattyToolHandlers;
  readonly evidence: RecommendationEvidence;
}

export interface ChattyAgentRuntime {
  readonly agent: Agent<ChattyRunContext>;
  run(
    input: string | AgentInputItem[],
    request: RecommendationRequest,
    evidence?: RecommendationEvidence,
  ): Promise<string>;
  close(): Promise<void>;
}

export interface ChattyAgentOptions {
  handlers: ChattyToolHandlers;
  model?: string;
  modelProvider?: ModelProvider;
  maxTurns?: number;
}

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseURL?: string;
}

const requireContext = (
  runContext: RunContext<ChattyRunContext> | undefined,
): ChattyRunContext => {
  if (!runContext) throw new Error("missing_run_context");
  return runContext.context;
};

const exposeModelResult = <TModel, TEvidence>(
  result: HarnessToolResult<TModel, TEvidence>,
): string => JSON.stringify(result.model);

const getProfileParameters = z.object({});
const searchParameters = z.object({
  categories: z.array(z.string()).max(20),
  minPriceCents: z.number().int().nonnegative(),
  maxPriceCents: z.number().int().positive(),
  tags: z.array(z.string()).max(20),
  limit: z.number().int().min(1).max(20),
});
const inventoryParameters = z.object({
  productIds: z.array(z.string()).min(1).max(20),
});
const knowledgeParameters = z.object({
  query: z.string().trim().min(1).max(200),
  categories: z.array(z.string()).max(20),
  productIds: z.array(z.string()).max(20),
  limit: z.number().int().min(1).max(8),
});
const marketingParameters = z.object({ segment: z.string().min(1).max(40) });
const createTools = () => {
  const getUserProfile = tool<typeof getProfileParameters, ChattyRunContext>({
    name: "get_user_profile",
    description:
      "获取当前用户画像。必须先调用；只读当前请求用户，不能修改画像。",
    parameters: getProfileParameters,
    async execute(_input, runContext) {
      const context = requireContext(runContext);
      const result = await context.handlers.getUserProfile(context.request);
      context.evidence.profile = result.evidence.profile;
      context.evidence.usedTools.push("get_user_profile");
      return exposeModelResult(result);
    },
  });

  const searchProducts = tool<typeof searchParameters, ChattyRunContext>({
    name: "search_products",
    description:
      "按结构化类目、价格和标签搜索商品。必须先获取画像；结果尚未校验库存。价格单位为分。",
    parameters: searchParameters,
    async execute(input, runContext) {
      const context = requireContext(runContext);
      if (!context.evidence.profile) throw new Error("profile_not_loaded");
      const preferred = context.request.context.preferredCategories;
      // 模型负责提出搜索参数；Harness 将它收窄到用户本轮明确约束，不能自行放宽预算或类目。
      const constrained = {
        ...input,
        categories: preferred.length ? preferred : input.categories,
        minPriceCents: Math.max(
          input.minPriceCents,
          context.request.context.minPriceCents ?? input.minPriceCents,
        ),
        maxPriceCents: Math.min(
          input.maxPriceCents,
          context.request.context.maxPriceCents ?? input.maxPriceCents,
        ),
      };
      const result = await context.handlers.searchProducts(
        context.request,
        constrained,
      );
      recordSearch(context.evidence, result.evidence.productIds);
      return exposeModelResult(result);
    },
  });

  const checkInventory = tool<typeof inventoryParameters, ChattyRunContext>({
    name: "check_inventory",
    description:
      "检查搜索召回商品的实时库存。只接受 search_products 返回过的商品 ID。",
    parameters: inventoryParameters,
    async execute(input, runContext) {
      const context = requireContext(runContext);
      if (
        input.productIds.some(
          (id) => !context.evidence.recalledProductIds.has(id),
        )
      ) {
        throw new Error("inventory_product_not_recalled");
      }
      const result = await context.handlers.checkInventory(
        context.request,
        input,
      );
      recordInventory(context.evidence, result.evidence.productIds);
      return exposeModelResult(result);
    },
  });

  const retrieveKnowledge = tool<typeof knowledgeParameters, ChattyRunContext>({
    name: "retrieve_knowledge",
    description:
      "用关键词全文检索商品与营销知识，为推荐理由提供依据；不能覆盖价格或库存事实。",
    parameters: knowledgeParameters,
    async execute(input, runContext) {
      const context = requireContext(runContext);
      const result = await context.handlers.retrieveKnowledge(
        context.request,
        input,
      );
      recordKnowledge(
        context.evidence,
        result.evidence.hits,
        result.evidence.groundedProductIds,
      );
      return exposeModelResult(result);
    },
  });

  const getMarketingStrategy = tool<
    typeof marketingParameters,
    ChattyRunContext
  >({
    name: "get_marketing_strategy",
    description:
      "获取画像分群对应的营销语气、写作要求和禁用词；segment 必须与画像一致。",
    parameters: marketingParameters,
    async execute(input, runContext) {
      const context = requireContext(runContext);
      if (!context.evidence.profile) throw new Error("profile_not_loaded");
      if (input.segment !== context.evidence.profile.segment) {
        throw new Error("marketing_segment_mismatch");
      }
      const result = await context.handlers.getMarketingStrategy(
        context.request,
        input,
      );
      context.evidence.usedTools.push("get_marketing_strategy");
      return exposeModelResult(result);
    },
  });

  return [
    getUserProfile,
    searchProducts,
    checkInventory,
    retrieveKnowledge,
    getMarketingStrategy,
  ];
};

const INSTRUCTIONS = `你是 Chatty，一个电商推荐与营销 Single Agent。

必须完成以下五步，不能只解释下一步，也不能在中途输出进度：
1. get_user_profile
2. search_products
3. check_inventory
4/5. retrieve_knowledge 与 get_marketing_strategy（两者可换序）

只推荐经过搜索、库存检查和知识检索支撑的商品。价格与库存只采用 tool result，不得编造商品、优惠或折扣。
五个 Tool 全部完成后停止调用 Tool，只输出下面形状的 JSON，不要 Markdown，不要说明文字：
{"action":"recommend","recommendations":[{"product_id":"商品ID","reason":"推荐理由","marketing_copy":"营销文案"}]}
需要澄清时才输出：{"action":"clarify","question":"问题"}`;

const createContext = (
  request: RecommendationRequest,
  handlers: ChattyToolHandlers,
  evidence: RecommendationEvidence,
): ChattyRunContext => ({
  request,
  handlers,
  evidence,
});

/** DeepSeek 的 OpenAI-compatible Responses endpoint，由 Agents SDK 持有 agent loop。 */
export const createDeepSeekProvider = ({
  apiKey,
  baseURL = "https://api.deepseek.com",
}: DeepSeekProviderOptions): OpenAIProvider =>
  new OpenAIProvider({ apiKey, baseURL, useResponses: true });

export const createChattyAgentRuntime = ({
  handlers,
  model = "deepseek-v4-flash",
  modelProvider,
  maxTurns = 12,
}: ChattyAgentOptions): ChattyAgentRuntime => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!modelProvider && !apiKey) throw new Error("missing_deepseek_api_key");
  const provider =
    modelProvider ??
    createDeepSeekProvider({
      apiKey: apiKey!,
      ...(process.env.DEEPSEEK_BASE_URL
        ? { baseURL: process.env.DEEPSEEK_BASE_URL }
        : {}),
    });
  const ownsProvider = modelProvider === undefined;
  const runner = new Runner({
    modelProvider: provider,
    tracingDisabled: true,
    workflowName: "Chatty recommendation",
  });
  const agent = new Agent<ChattyRunContext>({
    name: "Chatty",
    instructions: INSTRUCTIONS,
    model,
    tools: createTools(),
    modelSettings: {
      toolChoice: "required",
      parallelToolCalls: false,
      reasoning: { effort: "none" },
    },
    // SDK 默认即为 true；显式写出这一业务契约：首次强制 tool，调用后恢复 auto。
    resetToolChoice: true,
  });

  return {
    agent,
    async run(input, request, evidence = createEvidence()) {
      const context = createContext(request, handlers, evidence);
      const result = await runner.run(agent, input, { context, maxTurns });
      return typeof result.finalOutput === "string"
        ? result.finalOutput
        : JSON.stringify(result.finalOutput ?? "");
    },
    async close() {
      if (ownsProvider && provider instanceof OpenAIProvider)
        await provider.close();
    },
  };
};
