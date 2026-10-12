import { useEffect, useRef, useState } from "react";
import { CatalogBrowser } from "@/components/CatalogBrowser";
import { ProductCard } from "@/components/ProductCard";
import { ProductTable } from "@/components/ProductTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  createSession,
  explain,
  fetchCatalog,
  takeTurn,
  type CatalogInfo,
  type Product,
  type RunUsage,
  type Turn,
} from "@/lib/api-client";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "understood"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "question"; text: string }
  | { kind: "run"; trace: string[]; latencyMs: number; usage: RunUsage }
  | { kind: "products"; products: Product[] }
  | { kind: "error"; code: string };

export default function App() {
  const [view, setView] = useState<"chat" | "data">("chat");
  const [info, setInfo] = useState<CatalogInfo | null>(null);
  const [userId, setUserId] = useState("user_active");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [turnsLeft, setTurnsLeft] = useState<number | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, busy]);

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
      const responseEntries: Entry[] = [
        {
          kind: "run",
          trace: turn.trace,
          latencyMs: turn.latency_ms,
          usage: turn.usage,
        },
      ];
      if (turn.answer) responseEntries.push({ kind: "answer", text: turn.answer });
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
      const code =
        error instanceof ApiError ? error.code : "invalid_response";
      setEntries((current) => [...current, { kind: "error", code }]);
    } finally {
      setBusy(false);
    }
  };

  if (bootError) {
    return (
      <main className="mx-auto flex min-h-full max-w-lg flex-col justify-center gap-2 px-4">
        <p>{bootError}</p>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          先起后端：<code>make dev</code> 或 <code>go run ./backend/cmd/chatty</code>
        </p>
      </main>
    );
  }

  const exhausted = turnsLeft !== null && turnsLeft <= 0;
  const catalogSummary =
    info === null
      ? "载入中…"
      : `${info.model_id} · ${info.product_count} 件商品 · ${info.categories.length} 个类目`;

  return (
    <div
      className={`mx-auto flex h-dvh flex-col px-4 ${view === "data" ? "max-w-6xl" : "max-w-2xl"}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] py-6">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-wide">Chatty</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {catalogSummary}
          </p>
        </div>
        <Tabs
          value={view}
          onValueChange={(value) => setView(value as "chat" | "data")}
        >
          <TabsList>
            <TabsTrigger value="chat">对话</TabsTrigger>
            <TabsTrigger value="data">数据</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === "chat" ? (
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted-foreground)]">
            演示用户
            <select
              className="h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-foreground)]"
              value={userId}
              onChange={(event) => reset(event.target.value)}
              disabled={busy}
            >
              {info?.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-sm text-[var(--color-muted-foreground)]">
            只读
          </span>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto py-4">
        {view === "data" ? (
          <CatalogBrowser />
        ) : (
          <div className="space-y-3">
            {entries.length === 0 && info ? (
              <section className="space-y-2 rounded-lg border border-[var(--color-border)] p-4 text-sm">
                <p>用大白话说需求，比如「想买个降噪耳机，2000 以内」。</p>
                <p className="text-[var(--color-muted-foreground)]">
                  类目：{info.categories.join("、")}
                </p>
                <p className="text-[var(--color-muted-foreground)]">
                  换个身份问同样的需求，能看出画像对结果的影响。
                </p>
              </section>
            ) : null}
            {entries.map((entry, index) => (
              <Bubble key={index} entry={entry} />
            ))}
            {busy ? (
              <p className="text-sm text-[var(--color-muted-foreground)]">
                正在理解需求并执行必要步骤…
              </p>
            ) : null}
            <div ref={bottom} />
          </div>
        )}
      </main>

      {view === "chat" ? (
        <footer className="border-t border-[var(--color-border)] py-4">
          {exhausted ? (
            <p className="mb-2 text-sm text-[var(--color-muted-foreground)]">
              这段对话问到头了。{" "}
              <Button variant="link" className="h-auto p-0" onClick={() => reset()}>
                开一段新的
              </Button>
            </p>
          ) : null}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send(text);
            }}
          >
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={busy ? "正在跑…" : "想买点什么？"}
              disabled={busy || exhausted}
            />
            <Button type="submit" disabled={busy || !text.trim() || exhausted}>
              发送
            </Button>
          </form>
        </footer>
      ) : null}
    </div>
  );
}

function Bubble({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "user":
      return (
        <p className="ml-auto max-w-[85%] rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm text-[var(--color-primary-foreground)]">
          {entry.text}
        </p>
      );
    case "understood":
      return (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          理解为 · {entry.text}
        </p>
      );
    case "question":
    case "answer":
      return (
        <p className="max-w-[85%] rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm">
          {entry.text}
        </p>
      );
    case "error":
      return (
        <p className="rounded-md border border-[var(--color-destructive)] px-3 py-2 text-sm text-[var(--color-destructive)]">
          {explain(entry.code)}
          <span className="ml-2 font-mono text-xs opacity-70">{entry.code}</span>
        </p>
      );
    case "run":
      return (
        <RunTrace
          trace={entry.trace}
          latencyMs={entry.latencyMs}
          usage={entry.usage}
        />
      );
    case "products":
      return (
        <section className="space-y-3">
          {entry.products.length > 1 ? (
            <ProductTable products={entry.products} />
          ) : (
            entry.products.map((product) => (
              <ProductCard key={product.product_id} {...product} />
            ))
          )}
          <p className="text-xs text-[var(--color-muted-foreground)]">
            ID、名称、价格与库存均来自 SQLite 重查，并通过 Harness
            Evidence 校验；模型只写了理由和文案。
          </p>
        </section>
      );
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

const TRACE_LABELS: Record<string, string> = {
  request_parsing: "理解需求",
  get_user_profile: "读取用户画像",
  search_products: "搜索商品",
  check_inventory: "确认库存",
  retrieve_knowledge: "检索知识",
  get_marketing_strategy: "读取营销策略",
  response_generation: "生成回答",
  evidence_validation: "校验 Evidence",
};

const tokenNumber = new Intl.NumberFormat("zh-CN");

function RunTrace({
  trace,
  latencyMs,
  usage,
}: {
  trace: string[];
  latencyMs: number;
  usage: RunUsage;
}) {
  return (
    <details className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm">
      <summary className="cursor-pointer text-[var(--color-muted-foreground)]">
        完成 · {(latencyMs / 1000).toFixed(1)}s · {usage.model_requests} 次
        Model 请求 · {tokenNumber.format(usage.total_tokens)} tokens
      </summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        {trace.map((step) => (
          <li key={step}>{TRACE_LABELS[step] ?? step}</li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
        Input {tokenNumber.format(usage.input_tokens)} · Output{" "}
        {tokenNumber.format(usage.output_tokens)} tokens
      </p>
    </details>
  );
}
