/**
 * Task Framer：把整段用户对话抽取成结构化 TaskFrame。
 *
 * 它由 Harness 在主 Agent Loop 之前确定性调用，主 Agent 看不到它、也无法委派给它。
 * 没有 handoff、不持有对话历史、不能调用 Tool——占用 subagent slot，但不构成 Multi-Agent。
 *
 * `instructions.md` 是单行的：原提示词就没有换行，加换行就不是逐字搬运了。
 * `{{categories}}` 由本文件在构造 Agent 时替换成 SQLite 中真实存在的类目。
 */

import { Agent } from "@openai/agents";
import { z } from "zod";

import { readInstructions } from "../../lib/instructions.ts";
import type { ModelProvider } from "../../lib/model-provider.ts";

/**
 * DeepSeek Responses API 可接受的扁平 structured output。
 *
 * 数组最多只有一个元素，是为了兼容 provider 的 structured output 能力。
 */
export const taskFrameWireSchema = z.object({
  product_requested: z.boolean(),
  category: z.array(z.string()).max(1),
  min_yuan: z.array(z.number().min(0)).max(1),
  max_yuan: z.array(z.number().min(0)).max(1),
  knowledge_query: z.array(z.string()).max(1),
});
export type TaskFrameWire = z.infer<typeof taskFrameWireSchema>;

const INSTRUCTIONS_TEMPLATE = readInstructions(
  new URL("./instructions.md", import.meta.url),
);

/** 把 SQLite 中真实存在的商品类目写入 Task Framer Instructions。 */
export function taskFrameInstructions(categories: readonly string[]): string {
  // join 把 ["耳机", "键盘"] 变成适合给 Model 阅读的“耳机、键盘”。
  return INSTRUCTIONS_TEMPLATE.replace("{{categories}}", categories.join("、"));
}

/** 使用 Agents SDK structured output 声明 TaskFrame 契约。 */
export function buildTaskFrameAgent(
  provider: ModelProvider,
  categories: readonly string[],
) {
  return new Agent({
    name: "Chatty Task Framer",
    instructions: taskFrameInstructions(categories),
    model: provider.agentModel,
    outputType: taskFrameWireSchema,
    modelSettings: { reasoning: { effort: "none" } },
  });
}

export type TaskFrameAgent = ReturnType<typeof buildTaskFrameAgent>;
