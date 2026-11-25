/**
 * Chatty 主 Agent 的定义：Model、Tool 与结构化输出契约。
 *
 * 这里只声明 Agent 是什么，不负责怎么运行它——运行由 `lib/executor.ts` 承担。
 * 系统提示词放在同目录的 `instructions.md`，读取时不做任何加工。
 */

import { join } from "node:path";

import { Output, type LanguageModel } from "ai";

import {
  DRAFT_ACTIONS,
  buildAgentDraftSchema,
  type DraftAction,
} from "../data/models.ts";
import { readInstructions } from "./lib/instructions.ts";
import type { ModelProvider } from "./lib/model-provider.ts";
import { createGetMarketingStrategyTool } from "./tools/get_marketing_strategy.ts";
import { createRetrieveKnowledgeTool } from "./tools/retrieve_knowledge.ts";

const INSTRUCTIONS = readInstructions(
  join(process.cwd(), "src/agent/instructions.md"),
);

export type ChattyTools = {
  get_marketing_strategy: ReturnType<typeof createGetMarketingStrategyTool>;
  retrieve_knowledge: ReturnType<typeof createRetrieveKnowledgeTool>;
};

/**
 * 主 Agent 的装配结果：instructions、tools、结构化输出与默认 toolChoice。
 *
 * `allowedActions` 是本轮允许的 action 取值。传入收窄集合时，模型在解码阶段就发不出
 * 被禁的 action——这是防呆，不是提醒。默认值给全集，供测试与非请求上下文使用。
 */
export type ChattyAgentConfig = {
  name: "Chatty";
  instructions: string;
  model: LanguageModel;
  tools: ChattyTools;
  allowedActions: readonly [DraftAction, ...DraftAction[]];
  output: ReturnType<typeof Output.object>;
  toolChoice: "required";
  /** Single Agent 判据：主循环没有 handoff。 */
  handoffs: readonly [];
};

export function buildChattyTools(): ChattyTools {
  return {
    get_marketing_strategy: createGetMarketingStrategyTool(),
    retrieve_knowledge: createRetrieveKnowledgeTool(),
  };
}

export function buildChattyAgent(
  provider: ModelProvider,
  // `= DRAFT_ACTIONS` 是默认参数：不传就用全集。类型里的 `[T, ...T[]]`
  // 表示「至少一个元素的数组」，因为 Zod 的 enum 不接受空集合。
  allowedActions: readonly [DraftAction, ...DraftAction[]] = DRAFT_ACTIONS,
): ChattyAgentConfig {
  const schema = buildAgentDraftSchema(allowedActions);
  return {
    name: "Chatty",
    instructions: INSTRUCTIONS,
    model: provider.languageModel,
    tools: buildChattyTools(),
    allowedActions,
    output: Output.object({ schema }),
    toolChoice: "required",
    handoffs: [],
  };
}

export type ChattyAgentType = ReturnType<typeof buildChattyAgent>;
