/**
 * 获取画像分群对应的营销语气、写作要求与禁用词。
 *
 * 文件名即 Tool 名——本文件不写 `name` 字段，由 `index.ts` 从路径派生。
 */

import { z } from "zod";

import { defineTool } from "../lib/define-tool.ts";

import { requireContext } from "../lib/context.ts";
import { stageGuardrail } from "../lib/workflow.ts";

export default defineTool({
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
