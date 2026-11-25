/**
 * Chatty 会话 Hook：对齐 AI SDK UI 的 status / sendMessage 心智，
 * 但走领域 turn API，而不是 DefaultChatTransport 的自由文本流。
 *
 * Evidence 校验要求整轮草稿完整后才能返回推荐卡片，因此这里保持
 * turn-based；`@ai-sdk/react` 的 ChatStatus 语义复用在 UI 忙闲状态上。
 */

import { useCallback, useEffect, useState } from "react";
import type { ChatStatus } from "ai";

import type { ChatEntry } from "@/components/chat/types";
import {
  ApiError,
  createSession,
  takeTurn,
  type Turn,
} from "@/lib/api-client";

export type ChattySessionState = {
  sessionId: string | null;
  entries: ChatEntry[];
  status: ChatStatus;
  turnsLeft: number | null;
  text: string;
  setText: (value: string) => void;
  sendMessage: (raw: string) => Promise<void>;
  reset: () => void;
};

function entriesFromTurn(turn: Turn): ChatEntry[] {
  const responseEntries: ChatEntry[] = [
    {
      kind: "run",
      trace: turn.trace,
      latencyMs: turn.latency_ms,
      usage: turn.usage,
    },
  ];
  if (turn.answer) {
    responseEntries.push({ kind: "answer", text: turn.answer });
  }
  if (turn.kind === "recommend") {
    responseEntries.push({ kind: "products", products: turn.products });
  } else if (turn.kind !== "answer") {
    if (!turn.question) throw new ApiError("invalid_response");
    responseEntries.push({ kind: "question", text: turn.question });
  }
  return [
    { kind: "understood", text: turn.understood_as },
    ...responseEntries,
  ];
}

export function useChattySession(userId: string): ChattySessionState {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [turnsLeft, setTurnsLeft] = useState<number | null>(null);
  const [text, setText] = useState("");

  const reset = useCallback(() => {
    setSessionId(null);
    setEntries([]);
    setTurnsLeft(null);
    setStatus("ready");
    setText("");
  }, []);

  useEffect(() => {
    reset();
  }, [userId, reset]);

  const sendMessage = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || status === "submitted" || status === "streaming") return;
      setText("");
      setEntries((current) => [...current, { kind: "user", text: trimmed }]);
      setStatus("submitted");
      try {
        let activeSessionId = sessionId;
        if (activeSessionId === null) {
          const session = await createSession(userId);
          activeSessionId = session.session_id;
          setSessionId(activeSessionId);
        }
        setStatus("streaming");
        const turn = await takeTurn(activeSessionId, trimmed);
        setTurnsLeft(turn.turns_left);
        setEntries((current) => [...current, ...entriesFromTurn(turn)]);
        setStatus("ready");
      } catch (error: unknown) {
        const code =
          error instanceof ApiError ? error.code : "invalid_response";
        setEntries((current) => [...current, { kind: "error", code }]);
        setStatus("error");
      }
    },
    [sessionId, status, userId],
  );

  return {
    sessionId,
    entries,
    status,
    turnsLeft,
    text,
    setText,
    sendMessage,
    reset,
  };
}
