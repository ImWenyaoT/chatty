/**
 * Draft Corrector：provider 未遵守 schema 时，把最终文本改写回结构化契约。
 *
 * 与 request_parser 一样由 Harness 确定性调用（挂在 SDK 的 invalidFinalOutput 钩子上），
 * 主 Agent 看不到它。它只允许改写，不允许引入新事实——收敛仍由 finalizeReply 负责。
 */

import { Agent } from "@openai/agents";

import {
  DRAFT_ACTIONS,
  buildAgentDraftSchema,
  type DraftAction,
} from "../../../data/models.ts";
import { readInstructions } from "../../lib/instructions.ts";
import type { ModelProvider } from "../../lib/model-provider.ts";

const INSTRUCTIONS = readInstructions(
  new URL("./instructions.md", import.meta.url),
);

/**
 * 把 provider 未遵守 Schema 的最终文本纠正为同一个结构化契约。
 *
 * `allowedActions` 必须与主 Agent 本轮的取值范围一致——否则纠正会把主 Agent 发不出的
 * action 重新放进来，收窄就形同虚设。
 */
export function buildDraftCorrectionAgent(
  provider: ModelProvider,
  allowedActions: readonly [DraftAction, ...DraftAction[]] = DRAFT_ACTIONS,
) {
  return new Agent({
    name: "draft_corrector",
    instructions: INSTRUCTIONS,
    model: provider.agentModel,
    outputType: buildAgentDraftSchema(allowedActions),
    modelSettings: { reasoning: { effort: "none" } },
  });
}
