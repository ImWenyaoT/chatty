/**
 * 从目录派生主 Agent 可调用的 Tool 清单。
 *
 * 约定：`agent/tools/<name>.ts` 就是名为 `<name>` 的 Tool。Tool 文件 default-export
 * 一份**不含 name 的**参数对象（见 `lib/define-tool.ts`），名字由本文件按文件名注入——
 * 所以「文件名」是 Tool 名的唯一真相，不存在第二处需要同步的注册表。
 *
 * 共享代码一律放 `agent/lib/`，不能放在本目录：这里的每个 `.ts` 都会被当成一个 Tool。
 */

import { tool } from "@openai/agents";

import { TOOLS_DIR, TOOL_FILES } from "./names.ts";

export const CHATTY_TOOLS = await Promise.all(
  TOOL_FILES.map(async (file) => {
    const module = await import(new URL(file, TOOLS_DIR).href);
    // 漏写 default export 会在装配期立刻失败，而不是等模型调用时才发现。
    if (module.default === undefined) {
      throw new Error(`tool_missing_default_export:${file}`);
    }
    return tool({ name: file.slice(0, -".ts".length), ...module.default });
  }),
);

export { MODEL_TOOL_NAMES } from "./names.ts";
