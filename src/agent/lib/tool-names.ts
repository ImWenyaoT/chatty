/**
 * 从 `agent/tools/` 的目录列表派生模型可见的 Tool 名。
 *
 * 单独成文件是为了打破循环：Tool 实现会 import `evidence.ts`，而 evidence 需要知道
 * Tool 名。名字只依赖文件名、不依赖文件内容，所以这里只 readdir、不 import 任何 Tool——
 * 于是 evidence 拿名字时不会把 Tool 实现拖进来。
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 相对本文件定位，不依赖进程从哪个目录启动。 */
export const TOOLS_DIR = new URL("../tools/", import.meta.url);

/** `agent/tools/` 下的每个 `.ts` 都是一个 Tool，没有例外，因此不需要排除名单。 */
export const TOOL_FILES: readonly string[] = readdirSync(
  fileURLToPath(TOOLS_DIR),
)
  .filter((file) => file.endsWith(".ts"))
  .sort();

/** 模型可见的 Tool 名。Harness 确定性步骤不在此列，见 evidence.ts。 */
export const MODEL_TOOL_NAMES: readonly string[] = TOOL_FILES.map((file) =>
  file.slice(0, -".ts".length),
);
