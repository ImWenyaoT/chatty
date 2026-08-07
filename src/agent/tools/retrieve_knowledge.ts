/** 全文检索政策或商品知识，为回答和推荐理由提供依据。 */

import { tool } from "@openai/agents";
import { z } from "zod";

import { requireContext } from "../lib/context.ts";
import { recordKnowledge } from "../lib/evidence.ts";
import { stageGuardrail } from "../lib/workflow.ts";

export const retrieveKnowledge = tool({
  name: "retrieve_knowledge",
  description:
    "检索政策或商品知识。知识问题使用 general；商品推荐使用 product。0 命中时改写 query 后重试，不要原样重复。",
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

    let categories: string[] = [];
    let productIds: string[] = [];
    if (scope === "product") {
      if (context.request === null)
        throw new Error("recommendation_context_not_prepared");
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

    const hits = context.catalog.retrieveKnowledge({
      query,
      categories,
      productIds,
      limit,
    });

    const productSpecificIds = new Set<string>();
    const genericCategories = new Set<string>();
    if (scope === "product") {
      for (const hit of hits) {
        if (hit.product_id !== null) productSpecificIds.add(hit.product_id);
        else genericCategories.add(hit.category);
      }
    }

    const groundedIds = new Set(productSpecificIds);
    for (const product of context.catalog.inventory(productIds)) {
      if (genericCategories.has(product.category))
        groundedIds.add(product.product_id);
    }

    recordKnowledge(context.evidence, hits, [...groundedIds].sort(), scope);
    return JSON.stringify(hits);
  },
});
