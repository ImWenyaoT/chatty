/**
 * Draft Corrector：provider 未遵守 schema 时，把最终文本改写回结构化契约。
 *
 * 与 request_parser 一样由 Harness 确定性调用，主 Agent 看不到它。它只允许改写，
 * 不允许引入新事实——收敛仍由 finalizeReply 负责。
 */

import { join } from "node:path";

import { generateText, NoObjectGeneratedError, Output } from "ai";

import {
  DRAFT_ACTIONS,
  buildAgentDraftSchema,
  type AgentDraft,
  type DraftAction,
} from "../../../data/models.ts";
import { Usage } from "../../lib/evidence.ts";
import { readInstructions } from "../../lib/instructions.ts";
import type { ModelProvider } from "../../lib/model-provider.ts";

const INSTRUCTIONS = readInstructions(
  join(
    process.cwd(),
    "src/agent/subagents/draft_corrector/instructions.md",
  ),
);

export type DraftCorrectorConfig = {
  name: "draft_corrector";
  instructions: string;
  model: ModelProvider["languageModel"];
  allowedActions: readonly [DraftAction, ...DraftAction[]];
  schema: ReturnType<typeof buildAgentDraftSchema>;
};

/**
 * 把 provider 未遵守 Schema 的最终文本纠正为同一个结构化契约。
 *
 * `allowedActions` 必须与主 Agent 本轮的取值范围一致——否则纠正会把主 Agent 发不出的
 * action 重新放进来，收窄就形同虚设。
 */
export function buildDraftCorrectionAgent(
  provider: ModelProvider,
  allowedActions: readonly [DraftAction, ...DraftAction[]] = DRAFT_ACTIONS,
): DraftCorrectorConfig {
  return {
    name: "draft_corrector",
    instructions: INSTRUCTIONS,
    model: provider.languageModel,
    allowedActions,
    schema: buildAgentDraftSchema(allowedActions),
  };
}

/** Harness 触发的单次纠正；再次不合规时抛出。 */
export async function runDraftCorrector(
  corrector: DraftCorrectorConfig,
  rawText: string,
): Promise<{ output: AgentDraft; usage: Usage }> {
  try {
    const result = await generateText({
      model: corrector.model,
      instructions: corrector.instructions,
      prompt: rawText,
      output: Output.object({ schema: corrector.schema }),
      maxRetries: 0,
    });
    return {
      output: result.output,
      usage: Usage.fromAiSdk(result.usage, result.steps.length),
    };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new Error("correction_agent_rejected", { cause: error });
    }
    throw error;
  }
}
