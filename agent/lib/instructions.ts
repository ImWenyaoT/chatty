/**
 * 读取与 Agent 定义同目录的 instructions 文件。
 *
 * 不做 trim、不做模板替换：读出来的字符串必须与文件内容逐字节相等，
 * 否则 prompt 的真实内容就不再是 Markdown 文件里看到的那份。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readInstructions(url: URL): string {
  return readFileSync(fileURLToPath(url), "utf8");
}
