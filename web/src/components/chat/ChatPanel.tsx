import { useEffect, useRef } from "react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatEmptyState } from "@/components/chat/ChatEmptyState";
import { ChatEntryView } from "@/components/chat/ChatEntryView";
import type { ChatEntry } from "@/components/chat/types";
import type { CatalogInfo } from "@/lib/api-client";

export function ChatPanel({
  info,
  entries,
  text,
  onTextChange,
  onSend,
  busy,
  exhausted,
  onReset,
  turnsLeft,
}: {
  info: CatalogInfo | null;
  entries: ChatEntry[];
  text: string;
  onTextChange: (value: string) => void;
  onSend: (raw: string) => void;
  busy: boolean;
  exhausted: boolean;
  onReset: () => void;
  turnsLeft: number | null;
}) {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, busy]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-5">
        <div>
          <h2 className="text-sm font-semibold">对话</h2>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {turnsLeft === null
              ? "会话尚未开始"
              : exhausted
                ? "本轮已用尽"
                : `还可澄清 ${turnsLeft} 轮`}
          </p>
        </div>
        {entries.length > 0 ? (
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-[var(--color-muted-foreground)] underline-offset-2 hover:underline"
          >
            新对话
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
        {entries.length === 0 && info ? (
          <ChatEmptyState
            info={info}
            onExample={(example) => onSend(example)}
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {entries.map((entry, index) => (
              <ChatEntryView key={index} entry={entry} />
            ))}
            {busy ? (
              <p className="animate-pulse text-sm text-[var(--color-muted-foreground)]">
                正在理解需求并执行必要步骤…
              </p>
            ) : null}
            <div ref={bottom} />
          </div>
        )}
      </div>

      <ChatComposer
        value={text}
        onChange={onTextChange}
        onSubmit={() => onSend(text)}
        busy={busy}
        exhausted={exhausted}
        onReset={onReset}
      />
    </div>
  );
}
