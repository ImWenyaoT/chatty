import { useEffect, useState } from "react";
import { CatalogBrowser } from "@/components/catalog/CatalogBrowser";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { UserPicker } from "@/components/chat/UserPicker";
import { AppShell, type AppView } from "@/components/layout/AppShell";
import {
  ApiError,
  explain,
  fetchCatalog,
  type CatalogInfo,
} from "@/lib/api-client";
import { useChattySession } from "@/lib/use-chatty-session";

export default function App() {
  const [view, setView] = useState<AppView>("chat");
  const [info, setInfo] = useState<CatalogInfo | null>(null);
  const [userId, setUserId] = useState("user_active");
  const [bootError, setBootError] = useState<string | null>(null);
  const session = useChattySession(userId);

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
    if (nextUser === userId) {
      session.reset();
      return;
    }
    setUserId(nextUser);
  };

  const busy =
    session.status === "submitted" || session.status === "streaming";

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

  const exhausted =
    session.turnsLeft !== null && session.turnsLeft <= 0;
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
              entries={session.entries}
              text={session.text}
              onTextChange={session.setText}
              onSend={(raw) => void session.sendMessage(raw)}
              busy={busy}
              exhausted={exhausted}
              onReset={() => reset()}
              turnsLeft={session.turnsLeft}
            />
          </div>
        </div>
      ) : (
        <CatalogBrowser />
      )}
    </AppShell>
  );
}
