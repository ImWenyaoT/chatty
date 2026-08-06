/**
 * 声明一个 Tool，但不写它的名字。
 *
 * 名字由 `lib/tool-registry.ts` 从文件路径注入，所以这里刻意没有 `name` 字段：
 * 类型系统直接禁止在 Tool 文件里写名字，约定不靠自觉维持。
 *
 * 这个函数在运行时是恒等函数，它唯一的作用是把泛型推断带到定义处——否则 `execute`
 * 的参数拿不到 `parameters` schema 推出来的类型。
 *
 * 也没有 `inputGuardrails`：调用前裁决属于 `agent/hooks/`，由 registry 统一挂到每个
 * Tool 上，Tool 文件既不需要重复声明也不能覆盖。
 *
 * 形状比 SDK 的 `ToolOptions` 窄，只保留 chatty 实际用到的字段。收窄是有意的：
 * `ToolOptions` 是联合类型，`Omit` 会破坏推断；而且这也限定了 Tool 文件能做什么。
 */

import type { RunContext } from "@openai/agents";
import type { z } from "zod";

import type { ChattyRunContext } from "./context.ts";

/**
 * `<TParameters extends z.ZodObject>` 是泛型参数，读作「一个叫 TParameters 的类型占位符，
 * 它必须是一个 Zod object」。调用方不用手写它——TypeScript 会从你实际传入的 `parameters`
 * 反推出来。这就是为什么 `execute` 的 `input` 能自动拿到正确的字段。
 */
export type ChattyToolDefinition<TParameters extends z.ZodObject> = {
  description: string;
  parameters: TParameters;
  /** null 表示 Tool 抛错时直接终止，不把异常信息交回模型自行解释。 */
  errorFunction: null;
  execute: (
    // z.infer<T> 把一个 Zod schema「翻译」成对应的 TS 类型。
    // 比如 z.object({ query: z.string() }) 会被翻译成 { query: string }。
    // 好处是 schema 改了，这里的类型自动跟着变，不会两处写重。
    input: z.infer<TParameters>,
    // 参数名后面的 ? 表示可选，调用时可以不传。
    runContext?: RunContext<ChattyRunContext>,
  ) => Promise<string>;
};

export function defineTool<TParameters extends z.ZodObject>(
  definition: ChattyToolDefinition<TParameters>,
): ChattyToolDefinition<TParameters> {
  // 运行时什么都不做，原样返回。它存在的唯一理由是让上面那个泛型有机会被推断——
  // 直接写 `export default { ... }` 的话，TypeScript 不知道该按哪个类型检查。
  return definition;
}
