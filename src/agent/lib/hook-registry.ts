/**
 * 从 `agent/hooks/` 目录派生 Hook，并按 kind 分组。
 *
 * 约定与 `tools/` 一致：`agent/hooks/<name>.ts` 就是名为 `<name>` 的 Hook，文件里不写
 * 名字。装配器住在 `lib/`，所以 `hooks/` 下每个文件都是 Hook，没有例外、没有排除名单。
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CallModelInputFilter } from "@openai/agents";

import type {
  BeforeModelCallHook,
  BeforeToolCallHook,
  ChattyHook,
} from "./define-hook.ts";

const HOOKS_DIR = new URL("../hooks/", import.meta.url);

const HOOK_FILES: readonly string[] = readdirSync(fileURLToPath(HOOKS_DIR))
  .filter((file) => file.endsWith(".ts"))
  .sort();

export const HOOK_NAMES: readonly string[] = HOOK_FILES.map((file) =>
  file.slice(0, -".ts".length),
);

const HOOKS: readonly ChattyHook[] = await Promise.all(
  HOOK_NAMES.map(async (name) => {
    const module = await import(new URL(`${name}.ts`, HOOKS_DIR).href);
    if (module.default === undefined) {
      throw new Error(`hook_missing_default_export:${name}`);
    }
    return module.default as ChattyHook;
  }),
);

/**
 * 每次 Model 调用前运行。SDK 只接受一个 filter，所以这里把目录里的多个 Hook 串起来：
 * 前一个的输出作为后一个的 modelData，顺序即文件名字典序。
 */
// `BeforeModelCallHook["run"]` 是「索引访问类型」：取这个类型里 run 字段的类型，
// 不用再手写一遍它的函数签名。schema 改了这里自动跟着变。
const BEFORE_MODEL_CALL_HOOKS: readonly BeforeModelCallHook["run"][] =
  HOOKS.filter(
    // ChattyHook 是两种 Hook 的联合类型。按 kind 过滤之后用类型谓词告诉
    // TypeScript「剩下的都是 BeforeModelCallHook」，.map 里才能安全地取 .run。
    (hook): hook is BeforeModelCallHook => hook.kind === "before_model_call",
  ).map((hook) => hook.run);

export const BEFORE_MODEL_CALL: CallModelInputFilter = async (data) => {
  let modelData = data.modelData;
  for (const run of BEFORE_MODEL_CALL_HOOKS) {
    modelData = await run({ ...data, modelData });
  }
  return modelData;
};

/** 挂到每一个 Tool 上的调用前裁决。 */
export const BEFORE_TOOL_CALL: BeforeToolCallHook["run"][] = HOOKS.filter(
  (hook): hook is BeforeToolCallHook => hook.kind === "before_tool_call",
).map((hook) => hook.run);
