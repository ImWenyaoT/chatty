/**
 * 全文检索政策或商品知识，为回答和推荐理由提供依据。
 *
 * 文件名即 Tool 名——本文件不写 `name` 字段，由 `index.ts` 从路径派生。
 * Model 只能看到参数和描述，Catalog 与 Evidence 通过 ChattyRunContext 注入。
 */

import { z } from "zod";

import { defineTool } from "../lib/define-tool.ts";

import { guardRepeatedCall, recordKnowledge } from "../lib/evidence.ts";
import { stableStringify } from "../lib/stable-stringify.ts";
import { requireContext } from "../lib/context.ts";
import { stageGuardrail } from "../lib/workflow.ts";

export default defineTool({
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
