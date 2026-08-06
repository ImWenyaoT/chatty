/**
 * 每次调用 Model 前，把 Harness 的真实执行状态追加到 input 末尾。
 *
 * 追加而不改写原始对话：状态栏是对上下文的有损投影，删掉原始记录就没法回答
 * 状态栏没算过的维度。
 */

import { defineHook } from "../lib/define-hook.ts";
import { appendAgentStatus } from "../lib/workflow.ts";

export default defineHook({
  kind: "before_model_call",
  run: appendAgentStatus,
});
