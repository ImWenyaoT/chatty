/**
 * 读取与 Agent 定义同目录的 instructions 文件。
 *
 * `readInstructions` 不做 trim、不做替换：读出来的字符串与文件内容逐字节相等。
 * 需要插值时用 `renderInstructions`——它是唯一允许改写提示词的地方，且只替换
 * `{{name}}` 形式的占位符，其余部分仍然逐字节保留。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readInstructions(url: URL): string {
  return readFileSync(fileURLToPath(url), "utf8");
}

/** 按 `{{name}}` 占位符插值。除占位符外，其余内容逐字节保留。 */
export function renderInstructions(
  url: URL,
  // Record<K, V> 是「键是 K、值是 V 的对象」的简写，这里即 { [名字]: 替换成什么 }。
  // 外面套 Readonly<> 表示函数不会改动传进来的这个对象。
  vars: Readonly<Record<string, string>>,
): string {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    readInstructions(url),
  );
}
