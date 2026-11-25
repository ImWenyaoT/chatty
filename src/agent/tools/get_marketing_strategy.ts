/** 获取画像分群对应的营销语气、写作要求与禁用词。 */

import { tool } from "ai";
import { z } from "zod";

import { chattyRunContextSchema, requireContext } from "../lib/context.ts";
import {
  blockedToolPayload,
  gateToolCall,
  openToolBatch,
} from "../lib/workflow.ts";

export function createGetMarketingStrategyTool() {
  return tool({
    description: "获取画像分群对应的营销语气、写作要求与禁用词。",
    inputSchema: z.object({}),
    contextSchema: chattyRunContextSchema,
    execute: async (_input, { context: rawContext }) => {
      const context = requireContext(rawContext);
      context.batch ??= openToolBatch(context.evidence);
      const batch = context.batch;
      const decision = gateToolCall(batch, "get_marketing_strategy");
      if (!decision.allowed) {
        return blockedToolPayload(
          context.evidence,
          batch.stage,
          "get_marketing_strategy",
          decision.reason ?? "unplanned_tool_call",
        );
      }

      if (context.evidence.profile === null)
        throw new Error("profile_not_loaded");
      const strategy = context.catalog.marketingStrategy(
        context.evidence.profile.segment,
      );
      context.evidence.used_tools.push("get_marketing_strategy");
      return JSON.stringify(strategy);
    },
  });
}
