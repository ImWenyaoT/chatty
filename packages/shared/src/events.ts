import type { ConversationEvent } from "./types.js";

/**
 * 从 ConversationEvent 的 payload 中提取用户问题文本。
 * 曾有多个消费方各持一份逐字相同的实现（靠注释约定同步），
 * 收敛于此，保证所有调用方对同一事件永远读出同一问题。
 */
export function readQuestionFromEvent(event: ConversationEvent): string {
  if (typeof event.payload === "string") return event.payload;
  const obj = event.payload as { question?: unknown } | null;
  return typeof obj?.question === "string" ? obj.question : "";
}
