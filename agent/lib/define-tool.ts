/**
 * 声明一个 Tool，但不写它的名字。
 *
 * 名字由 `agent/tools/index.ts` 从文件路径注入，所以这里刻意没有 `name` 字段：
 * 类型系统直接禁止在 Tool 文件里写名字，约定不靠自觉维持。
 *
 * 这个函数在运行时是恒等函数，它唯一的作用是把泛型推断带到定义处——否则 `execute`
 * 的参数拿不到 `parameters` schema 推出来的类型。
 *
 * 形状比 SDK 的 `ToolOptions` 窄，只保留 chatty 实际用到的字段。收窄是有意的：
 * `ToolOptions` 是联合类型，`Omit` 会破坏推断；而且这也限定了 Tool 文件能做什么。
 */

import type { RunContext, ToolInputGuardrailDefinition } from "@openai/agents";
import type { z } from "zod";

import type { ChattyRunContext } from "./context.ts";

export type ChattyToolDefinition<TParameters extends z.ZodObject> = {
  description: string;
  parameters: TParameters;
  /** null 表示 Tool 抛错时直接终止，不把异常信息交回模型自行解释。 */
  errorFunction: null;
  inputGuardrails: ToolInputGuardrailDefinition<ChattyRunContext>[];
  execute: (
    input: z.infer<TParameters>,
    runContext?: RunContext<ChattyRunContext>,
  ) => Promise<string>;
};

export function defineTool<TParameters extends z.ZodObject>(
  definition: ChattyToolDefinition<TParameters>,
): ChattyToolDefinition<TParameters> {
  return definition;
}
