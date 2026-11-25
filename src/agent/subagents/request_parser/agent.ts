/**
 * Request Parser：把整段用户对话抽取成结构化 ParsedRequest。
 *
 * 它由 Harness 在主 Agent Loop 之前确定性调用，主 Agent 看不到它、也无法委派给它。
 * 没有 handoff、不持有对话历史、不能调用 Tool——占用 subagent slot，但不构成 Multi-Agent。
 */

import { join } from "node:path";

import { z } from "zod";

import { renderInstructions } from "../../lib/instructions.ts";
import type { ModelProvider } from "../../lib/model-provider.ts";

/** Request Parser 的输出契约：模型看到的就是这个形状。 */
export const requestParseOutputSchema = z.object({
  product_requested: z.boolean(),
  category: z.string().nullable(),
  min_yuan: z.number().min(0).nullable(),
  max_yuan: z.number().min(0).nullable(),
  knowledge_query: z.string().nullable(),
});

export type RequestParseOutput = z.infer<typeof requestParseOutputSchema>;

const INSTRUCTIONS_PATH = join(
  process.cwd(),
  "src/agent/subagents/request_parser/instructions.md",
);

/** 把 SQLite 中真实存在的商品类目写入 Request Parser Instructions。 */
export function requestParserInstructions(
  categories: readonly string[],
): string {
  return renderInstructions(INSTRUCTIONS_PATH, {
    categories: categories.join("、"),
  });
}

export type RequestParserConfig = {
  name: "request_parser";
  instructions: string;
  model: ModelProvider["languageModel"];
  schema: typeof requestParseOutputSchema;
};

/** 声明请求解析契约；实际调用见 `lib/framing.ts` 的 `runRequestParser`。 */
export function buildRequestParser(
  provider: ModelProvider,
  categories: readonly string[],
): RequestParserConfig {
  return {
    name: "request_parser",
    instructions: requestParserInstructions(categories),
    model: provider.languageModel,
    schema: requestParseOutputSchema,
  };
}

export type RequestParser = RequestParserConfig;
