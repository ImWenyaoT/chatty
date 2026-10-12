import { useEffect, useState } from "react";
import { CatalogBrowser } from "@/components/catalog/CatalogBrowser";
import { ChatPanel } from "@/components/chat/ChatPanel";
import type { ChatEntry } from "@/components/chat/types";
import { UserPicker } from "@/components/chat/UserPicker";
import { AppShell, type AppView } from "@/components/layout/AppShell";
import {
  ApiError,
  createSession,
  explain,
  fetchCatalog,
  takeTurn,
  type CatalogInfo,
  type Turn,
} from "@/lib/api-client";

export default function App() {
  const [view, setView] = useState<AppView>("chat");
  const [info, setInfo] = useState<CatalogInfo | null>(null);
  const [userId, setUserId] = useState("user_active");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [turnsLeft, setTurnsLeft] = useState<number | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await fetchCatalog());
      } catch (error: unknown) {
        setBootError(
          explain(error instanceof ApiError ? error.code : "invalid_response"),
        );
      }
    })();
  }, []);

  const reset = (nextUser = userId) => {
    setUserId(nextUser);
    setSessionId(null);
    setEntries([]);
    setTurnsLeft(null);
  };

  const send = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || busy) return;
    setText("");
    setEntries((current) => [...current, { kind: "user", text: trimmed }]);
    setBusy(true);
    try {
      let activeSessionId = sessionId;
      if (activeSessionId === null) {
        const session = await createSession(userId);
        activeSessionId = session.session_id;
        setSessionId(activeSessionId);
      }
      const turn: Turn = await takeTurn(activeSessionId, trimmed);
      setTurnsLeft(turn.turns_left);
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
      setEntries((current) => [
        ...current,
        { kind: "understood", text: turn.understood_as },
        ...responseEntries,
      ]);
    } catch (error: unknown) {
      const code = error instanceof ApiError ? error.code : "invalid_response";
      setEntries((current) => [...current, { kind: "error", code }]);
    } finally {
      setBusy(false);
    }
  };

  if (bootError) {
    return (
      <main className="mx-auto flex min-h-full max-w-lg flex-col justify-center gap-3 px-4">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold text-[var(--color-primary)]">
          Chatty
        </h1>
        <p>{bootError}</p>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          先起后端：<code>make api-dev</code>
        </p>
      </main>
    );
  }

  const exhausted = turnsLeft !== null && turnsLeft <= 0;
  const catalogSummary =
    info === null
      ? "载入中…"
      : `${info.model_id} · ${info.product_count} 件商品 · ${info.categories.length} 类目`;

  return (
    <AppShell
      view={view}
      onViewChange={setView}
      summary={catalogSummary}
      sidebarExtra={
        view === "chat" && info ? (
          <UserPicker
            users={info.users}
            value={userId}
            onChange={(next) => reset(next)}
            disabled={busy}
          />
        ) : (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            数据页只读，不会修改 SQLite。
          </p>
        )
      }
    >
      {view === "chat" ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-[var(--color-border)] px-4 py-3 md:hidden">
            {info ? (
              <UserPicker
                users={info.users}
                value={userId}
                onChange={(next) => reset(next)}
                disabled={busy}
              />
            ) : null}
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel
              info={info}
              entries={entries}
              text={text}
              onTextChange={setText}
              onSend={(raw) => void send(raw)}
              busy={busy}
              exhausted={exhausted}
              onReset={() => reset()}
              turnsLeft={turnsLeft}
            />
          </div>
        </div>
      ) : (
        <CatalogBrowser />
      )}
    </AppShell>
  );
}
