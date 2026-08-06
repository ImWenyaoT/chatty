/**
 * 每个 Tool 执行前按当前阶段裁决这次调用，被拒的调用不执行、原因回给模型。
 *
 * registry 会把它挂到 `agent/tools/` 下的每一个 Tool 上，所以 Tool 文件里不需要、
 * 也不能再声明 guardrail——少一处逐文件重复的接线。
 */

import { defineHook } from "../lib/define-hook.ts";
import { stageGuardrail } from "../lib/workflow.ts";

export default defineHook({
  kind: "before_tool_call",
  run: stageGuardrail,
});
