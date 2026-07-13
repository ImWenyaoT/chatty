import type { SessionRepository, TraceRepository } from "@rental/db";
import type {
  JsonValue,
  PlaygroundHistoryMessage,
  PlaygroundHistoryResponse,
} from "@rental/shared";

type ConversationHistoryRepos = {
  sessions: Pick<SessionRepository, "findByConversation">;
  traces: Pick<TraceRepository, "queryBySession">;
};

function readString(value: JsonValue | undefined, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readUserContent(input: JsonValue) {
  const question = readString(input, "question") ?? "";
  const imageUrl = readString(input, "imageUrl");
  if (imageUrl) {
    return `${question || "发送了一张图片"}\n图片：${imageUrl}`;
  }
  return question || undefined;
}

/** Reconstructs the seller transcript from the authoritative persisted traces. */
export function readConversationHistory(
  repos: ConversationHistoryRepos,
  conversationId: string,
): PlaygroundHistoryResponse {
  const session = repos.sessions.findByConversation(conversationId);
  if (!session)
    return { conversationId, hasEarlierMessages: false, messages: [] };

  const traces = repos.traces.queryBySession(session.id, 101);
  const hasEarlierMessages = traces.length > 100;
  const visibleTraces = hasEarlierMessages ? traces.slice(1) : traces;
  const messages = visibleTraces.flatMap<PlaygroundHistoryMessage>((trace) => {
    const userContent = readUserContent(trace.input);
    const reply = readString(trace.output, "reply");
    return [
      ...(userContent
        ? [
            {
              id: `${trace.id}:user`,
              role: "user" as const,
              content: userContent,
              createdAt: trace.createdAt,
            },
          ]
        : []),
      ...(reply
        ? [
            {
              id: `${trace.id}:assistant`,
              role: "assistant" as const,
              content: reply,
              traceId: trace.id,
              sessionId: session.id,
              createdAt: trace.createdAt,
            },
          ]
        : []),
    ];
  });

  return {
    conversationId,
    sessionId: session.id,
    hasEarlierMessages,
    messages,
  };
}
