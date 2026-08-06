/**
 * Chatty 主 Agent 的定义：Model、Tool 与结构化输出契约。
 *
 * 这里只声明 Agent 是什么，不负责怎么运行它——运行由 `lib/executor.ts` 承担。
 * 系统提示词放在同目录的 `instructions.md`，读取时不做任何加工。
 */

import { Agent } from "@openai/agents";

import {
  DRAFT_ACTIONS,
  buildAgentDraftSchema,
  type DraftAction,
} from "../data/models.ts";
import type { ChattyRunContext } from "./lib/context.ts";
import { readInstructions } from "./lib/instructions.ts";
import type { ModelProvider } from "./lib/model-provider.ts";
import { getMarketingStrategy } from "./tools/get_marketing_strategy.ts";
import { retrieveKnowledge } from "./tools/retrieve_knowledge.ts";

const INSTRUCTIONS = readInstructions(
  new URL("./instructions.md", import.meta.url),
);

/**
 * 使用 Agents SDK 声明 Chatty 的 Model、Tool 与结构化输出契约。
 *
 * `allowedActions` 是本轮允许的 action 取值。传入收窄集合时，模型在解码阶段就发不出
 * 被禁的 action——这是防呆，不是提醒。默认值给全集，供测试与非请求上下文使用。
 */
export function buildChattyAgent(
  provider: ModelProvider,
  // `= DRAFT_ACTIONS` 是默认参数：不传就用全集。类型里的 `[T, ...T[]]`
  // 表示「至少一个元素的数组」，因为 Zod 的 enum 不接受空集合。
  allowedActions: readonly [DraftAction, ...DraftAction[]] = DRAFT_ACTIONS,
) {
  const outputType = buildAgentDraftSchema(allowedActions);
  return new Agent<ChattyRunContext, typeof outputType>({
    name: "Chatty",
    instructions: INSTRUCTIONS,
    model: provider.agentModel,
    tools: [getMarketingStrategy, retrieveKnowledge],
    // SDK 会把最终输出交给 Zod，运行时验证是否符合 AgentDraft。
    outputType,
    // toolChoice="required" 强制第一轮先调用 Tool，不能跳过事实准备直接生成答案。
    modelSettings: { toolChoice: "required", reasoning: { effort: "none" } },
    resetToolChoice: true,
  });
}

// ReturnType<typeof f> 读作「f 这个函数返回值的类型」。这里不手写 Agent<...> 那一长串
// 泛型，而是让它跟着 buildChattyAgent 走——函数改了，类型自动跟着改。
export type ChattyAgentType = ReturnType<typeof buildChattyAgent>;
