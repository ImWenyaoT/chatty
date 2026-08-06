import { useEffect, useRef, useState } from "react";
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
} from "../lib/api";
import CatalogBrowser from "../components/CatalogBrowser";

/**
 * 会话里的一条记录。
 *
 * `understood` 单独占一条是刻意的：这个项目的论点是「模型说了不算」，而输入适配把
 * 大白话解析成什么条件，正是第一处「模型说了算不算」的地方——让人看见它，比直接
 * 跳到结果更说明问题。
 */
type Entry =
  | { kind: "user"; text: string }
  | { kind: "understood"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "question"; text: string }
  | { kind: "run"; trace: string[]; latencyMs: number; usage: RunUsage }
  | { kind: "products"; products: Product[] }
  | { kind: "error"; code: string };

const yuan = (cents: number) => (cents / 100).toFixed(2);

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
    const loadCatalog = async () => {
      try {
        setInfo(await fetchCatalog());
      } catch (error: unknown) {
        let code = "invalid_response";
        if (error instanceof ApiError) {
          code = error.code;
        } else {
          console.error("unexpected Chatty boot error", error);
        }
        setBootError(explain(code));
      }
    };

    void loadCatalog();
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
      // 会话惰性开：换了身份却不发消息，就不该占一个会话
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
      if (turn.answer) {
        responseEntries.push({ kind: "answer", text: turn.answer });
      }
      if (turn.kind === "recommend") {
        responseEntries.push({
          kind: "products",
          products: turn.products,
        });
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
      let code = "invalid_response";
      if (error instanceof ApiError) {
        code = error.code;
      } else {
        console.error("unexpected Chatty error", error);
      }
      setEntries((current) => [...current, { kind: "error", code }]);
    } finally {
      setBusy(false);
    }
  };

  if (bootError) {
    return (
      <main className="boot-error">
        <p>{bootError}</p>
        <p className="hint">
          先起后端：<code>pnpm dev</code>
        </p>
      </main>
    );
  }

  const exhausted = turnsLeft !== null && turnsLeft <= 0;
  let catalogSummary = "载入中…";
  if (info !== null) {
    catalogSummary = `${info.model_id} · ${info.product_count} 件商品 · ${info.categories.length} 个类目`;
  }

  let inputPlaceholder = "想买点什么？";
  if (busy) inputPlaceholder = "正在跑…";

  return (
    <div className={view === "data" ? "app data-mode" : "app"}>
      <header>
        <div className="brand">
          <h1>Chatty</h1>
          <p className="hint">{catalogSummary}</p>
        </div>
        <nav className="primary-tabs" aria-label="主要功能">
          <button
            type="button"
            className={view === "chat" ? "tab active" : "tab"}
            onClick={() => setView("chat")}
          >
            对话
          </button>
          <button
            type="button"
            className={view === "data" ? "tab active" : "tab"}
            onClick={() => setView("data")}
          >
            数据
          </button>
        </nav>
        {view === "chat" ? (
          <label className="identity">
            演示用户
            <select
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
          <span className="read-only">只读</span>
        )}
      </header>

      <main>
        {view === "data" ? (
          <CatalogBrowser />
        ) : (
          <>
            {entries.length === 0 && info && (
              <section className="intro">
                <p>用大白话说需求，比如「想买个降噪耳机，2000 以内」。</p>
                <p className="hint">类目：{info.categories.join("、")}</p>
                <p className="hint">
                  换个身份问同样的需求，能看出画像对结果的影响。
                </p>
              </section>
            )}

            {entries.map((entry, index) => (
              <Bubble key={index} entry={entry} />
            ))}

            {busy ? (
              <p className="thinking">正在理解需求并执行必要步骤…</p>
            ) : null}
            <div ref={bottom} />
          </>
        )}
      </main>

      {view === "chat" ? (
        <footer>
          {exhausted && (
            <p className="hint">
              这段对话问到头了。
              <button type="button" className="link" onClick={() => reset()}>
                开一段新的
              </button>
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(text);
            }}
          >
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={inputPlaceholder}
              disabled={busy || exhausted}
            />
            <button type="submit" disabled={busy || !text.trim() || exhausted}>
              发送
            </button>
          </form>
        </footer>
      ) : null}
    </div>
  );
}

function Bubble({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "user":
      return <p className="bubble user">{entry.text}</p>;
    case "understood":
      return <p className="understood">理解为 · {entry.text}</p>;
    case "question":
      return <p className="bubble agent">{entry.text}</p>;
    case "answer":
      return <p className="bubble agent">{entry.text}</p>;
    case "error":
      return (
        <p className="bubble error">
          {explain(entry.code)}
          <span className="code">{entry.code}</span>
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
        <section className="products">
          {entry.products.map((product) => (
            <ProductCard key={product.product_id} product={product} />
          ))}
          <p className="hint">
            ID、名称、价格与库存均来自 SQLite 重查，并通过 Harness
            六条证据校验；模型只写了理由和文案。
          </p>
        </section>
      );
  }
}

const TRACE_LABELS: Record<string, string> = {
  task_framing: "理解需求",
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
    <details className="run-trace">
      <summary>
        完成 · {(latencyMs / 1000).toFixed(1)}s · {usage.model_requests} 次
        Model 请求 · {tokenNumber.format(usage.total_tokens)} tokens
      </summary>
      <ol>
        {trace.map((step) => (
          <li key={step}>{TRACE_LABELS[step] ?? step}</li>
        ))}
      </ol>
      <p>
        Input {tokenNumber.format(usage.input_tokens)} · Output{" "}
        {tokenNumber.format(usage.output_tokens)} tokens
      </p>
    </details>
  );
}

function ProductCard({ product }: { product: Product }) {
  let stockClassName = "";
  let stockLabel = "有货";
  if (product.low_stock) {
    stockClassName = "low";
    stockLabel = "库存紧张";
  }

  return (
    <article className="card">
      <div className="card-head">
        <span className="name">{product.name}</span>
        <span className="price">¥{yuan(product.price_cents)}</span>
      </div>
      <p className="meta">
        <span className="id">{product.product_id}</span>
        <span>{product.brand}</span>
        <span className={stockClassName}>{stockLabel}</span>
        {product.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
      </p>
      <p className="reason">{product.reason}</p>
      <p className="copy">{product.marketing_copy}</p>
    </article>
  );
}
