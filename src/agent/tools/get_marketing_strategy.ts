/** 获取画像分群对应的营销语气、写作要求与禁用词。 */

import { tool } from "@openai/agents";
import { z } from "zod";

import { requireContext } from "../lib/context.ts";
import { stageGuardrail } from "../lib/workflow.ts";

export const getMarketingStrategy = tool({
  name: "get_marketing_strategy",
  description: "获取画像分群对应的营销语气、写作要求与禁用词。",
  parameters: z.object({}),
  errorFunction: null,
  inputGuardrails: [stageGuardrail],
  execute: async (_input, runContext) => {
    const context = requireContext(runContext);
    if (context.evidence.profile === null)
      throw new Error("profile_not_loaded");
    const strategy = context.catalog.marketingStrategy(
      context.evidence.profile.segment,
    );
    context.evidence.used_tools.push("get_marketing_strategy");
    return JSON.stringify(strategy);
  },
});
