/**
 * 主 Agent 可调用的知识检索与营销策略 Tool。
 *
 * `tool()` 把普通函数包装成 Model 可见的 Tool Schema。Model 只能看到名称、参数和描述，
 * 真正的 Catalog 与 Evidence 通过 ChattyRunContext 注入，因此 Model 不能替换数据库，
 * 也不能直接修改 Harness Evidence。
 */

import { type RunContext, tool } from "@openai/agents";
import { z } from "zod";

import type { ChattyRunContext } from "./context.ts";
import { guardRepeatedCall, recordKnowledge } from "./evidence.ts";
import { stageGuardrail } from "./workflow.ts";

/** 递归排序 key，让同一组参数总是得到同一个签名。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export { stableStringify };

/** Tool 的运行时依赖只能来自 RunContext，缺失时属于 Harness 装配错误。 */
function requireContext(
  runContext: RunContext<ChattyRunContext> | undefined,
): ChattyRunContext {
  if (runContext === undefined) throw new Error("run_context_not_prepared");
  return runContext.context;
}

const retrieveKnowledge = tool({
  name: "retrieve_knowledge",
  description: "全文检索政策或商品知识，为回答和推荐理由提供依据。",
  parameters: z.object({
    query: z.string().describe("关键词查询。"),
    limit: z.number().int().min(1).max(8).describe("最多返回的知识块数量。"),
    scope: z
      .enum(["general", "product"])
      .describe(
        "general 检索政策等通用知识；product 只检索当前在售候选商品知识。",
      ),
  }),
  errorFunction: null,
  inputGuardrails: [stageGuardrail],
  execute: async ({ query, limit, scope }, runContext) => {
    const context = requireContext(runContext);

    // general 检索不限定商品；product 检索会在下面填入当前类目和有库存商品 ID。
    let categories: string[] = [];
    let productIds: string[] = [];
    if (scope === "product") {
      // 这是运行时保护：即使类型允许 request 为 null，商品检索也明确禁止这种状态。
      if (context.request === null)
        throw new Error("recommendation_context_not_prepared");
      // 用户本轮明确类目优先；没有明确类目时才使用历史画像偏好。
      const explicitCategories =
        context.request.context.preferred_categories ?? [];
      const profile = context.evidence.profile;
      if (profile === null) throw new Error("profile_not_loaded");
      categories =
        explicitCategories.length > 0
          ? explicitCategories
          : profile.preferred_categories;
      productIds = context.evidence.in_stock_product_order;
    }
    const signature = stableStringify({
      query,
      categories,
      product_ids: productIds,
      limit,
      scope,
    });
    guardRepeatedCall(context.evidence, "retrieve_knowledge", signature);
    const hits = context.catalog.retrieveKnowledge({
      query,
      categories,
      productIds,
      limit,
    });

    // general 知识只支撑回答；product 知识还要计算它能够支撑哪些推荐商品。
    const productSpecificIds = new Set<string>();
    const genericCategories = new Set<string>();
    if (scope === "product") {
      for (const hit of hits) {
        // 商品专属文档只支撑自己的 product_id。
        if (hit.product_id !== null) productSpecificIds.add(hit.product_id);
        // 类目通用文档可以支撑当前候选中同类目的全部商品。
        else genericCategories.add(hit.category);
      }
    }

    const groundedIds = new Set(productSpecificIds);
    for (const product of context.catalog.inventory(productIds)) {
      if (genericCategories.has(product.category))
        groundedIds.add(product.product_id);
    }

    // 先记录 Harness Evidence，再把同一批命中序列化后返回给 Model。
    recordKnowledge(context.evidence, hits, [...groundedIds].sort(), scope);
    return JSON.stringify(hits);
  },
});

const getMarketingStrategy = tool({
  name: "get_marketing_strategy",
  description: "获取画像分群对应的营销语气、写作要求与禁用词。",
  parameters: z.object({}),
  errorFunction: null,
  inputGuardrails: [stageGuardrail],
  execute: async (_input, runContext) => {
    const context = requireContext(runContext);
    // 营销策略依赖用户分群，因此画像未加载时宁可明确失败，也不使用默认语气。
    if (context.evidence.profile === null)
      throw new Error("profile_not_loaded");
    const strategy = context.catalog.marketingStrategy(
      context.evidence.profile.segment,
    );
    // 只有真实读取成功后才把 Tool 记入 used_tools。
    context.evidence.used_tools.push("get_marketing_strategy");
    return JSON.stringify(strategy);
  },
});

// 这是主 Agent 唯一可见的 Tool 清单。画像、搜索和库存由 Harness 提前确定性执行。
export const CHATTY_TOOLS = [retrieveKnowledge, getMarketingStrategy];
