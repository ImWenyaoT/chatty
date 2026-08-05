import type { ModelResponse } from "@openai/agents";

/** provider 可能把结构化输出拆成多个 output item，这里拼回完整文本。 */
export function extractResponseText(
  responses: readonly ModelResponse[],
): string {
  let text = "";
  for (const response of responses) {
    for (const item of response.output) {
      if (item.type !== "message") continue;
      // content 可能是纯文本，也可能是分段的结构化内容。
      if (typeof item.content === "string") {
        text += item.content;
        continue;
      }
      for (const part of item.content) {
        if (typeof part !== "string" && part.type === "output_text")
          text += part.text;
      }
    }
  }
  return text;
}
