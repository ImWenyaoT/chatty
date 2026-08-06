/**
 * 声明一个 Hook，但不写它的名字——名字由 `lib/hook-registry.ts` 从文件路径注入。
 *
 * `kind` 决定这个 Hook 挂在哪个生命周期点上，装配由 registry 完成，不在 executor 里
 * 手工接线，也不在每个 Tool 文件里重复声明。
 */

import type {
  CallModelInputFilter,
  ToolInputGuardrailDefinition,
} from "@openai/agents";

import type { ChattyRunContext } from "./context.ts";

/** 每次调用 Model 之前改写送进去的 input。 */
export type BeforeModelCallHook = {
  kind: "before_model_call";
  run: CallModelInputFilter;
};

/** 每个 Tool 执行之前裁决这次调用。registry 会把它挂到所有 Tool 上。 */
export type BeforeToolCallHook = {
  kind: "before_tool_call";
  run: ToolInputGuardrailDefinition<ChattyRunContext>;
};

// `A | B` 是联合类型：一个 ChattyHook 要么是前者要么是后者。
// 两者都有 kind 字段且取值互不相同，所以 TypeScript 能靠 `hook.kind === "..."`
// 判断出具体是哪一种——这叫可辨识联合（discriminated union）。
export type ChattyHook = BeforeModelCallHook | BeforeToolCallHook;

// 泛型写成 <THook extends ChattyHook> 而不是直接用 ChattyHook 做参数类型，
// 是为了让返回值保留调用方传进来的**具体**那一种，而不是退化成联合类型。
export function defineHook<THook extends ChattyHook>(hook: THook): THook {
  return hook;
}
