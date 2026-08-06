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

import { renderInstructions } from "../../lib/instructions.ts";
import type { ModelProvider } from "../../lib/model-provider.ts";

/**
 * Task Framer 的输出契约：模型看到的就是这个形状。
 *
 * 字段用可空标量而不是「最多一个元素的数组」。早先那种拍平写法是为了绕
 * provider 的 structured output 限制，实测 DeepSeek 支持可空字段，不需要绕。
 */
export const taskFrameWireSchema = z.object({
  product_requested: z.boolean(),
  category: z.string().nullable(),
  min_yuan: z.number().min(0).nullable(),
  max_yuan: z.number().min(0).nullable(),
  knowledge_query: z.string().nullable(),
});
// 从 Zod schema 反推 TS 类型：schema 里写 z.string().nullable()，这里就得到 string | null。
// 只维护 schema 一处，类型不会和校验规则脱节。
export type TaskFrameWire = z.infer<typeof taskFrameWireSchema>;

const INSTRUCTIONS_URL = new URL("./instructions.md", import.meta.url);

/** 把 SQLite 中真实存在的商品类目写入 Task Framer Instructions。 */
export function taskFrameInstructions(categories: readonly string[]): string {
  // join 把 ["耳机", "键盘"] 变成适合给 Model 阅读的“耳机、键盘”。
  return renderInstructions(INSTRUCTIONS_URL, {
    categories: categories.join("、"),
  });
}

/** 使用 Agents SDK structured output 声明 TaskFrame 契约。 */
export function buildTaskFrameAgent(
  provider: ModelProvider,
  categories: readonly string[],
) {
  return new Agent({
    name: "task_framer",
    instructions: taskFrameInstructions(categories),
    model: provider.agentModel,
    outputType: taskFrameWireSchema,
    modelSettings: { reasoning: { effort: "none" } },
  });
}

export type TaskFrameAgent = ReturnType<typeof buildTaskFrameAgent>;
