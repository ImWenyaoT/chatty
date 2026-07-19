"use client";

import { useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { SellerNavigation } from "../components/seller/SellerNavigation";

const API_BASE_URL = "http://127.0.0.1:8000";

type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

type RunResponse = {
  reply: string;
  customer_id: string;
  session_id: string;
  trace_id: string;
  status: "completed" | "not_completed" | "responded";
  knowledge_search_results: KnowledgeResult[];
  memory_events: MemoryEvent[];
};

type CustomerMemory = {
  memory_id: string;
  customer_id: string;
  fact: string;
  source_id: string;
  created_at: string;
};

type MemoryEvent = {
  tool: string;
  memories: CustomerMemory[];
};

type KnowledgeResult = {
  id: string;
  title: string;
  summary: string;
  body: string;
  source: string;
  tags: string[];
};

function isKnowledgeResult(payload: unknown): payload is KnowledgeResult {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.body === "string" &&
    typeof candidate.source === "string" &&
    Array.isArray(candidate.tags) &&
    candidate.tags.every((tag) => typeof tag === "string")
  );
}

function isRunResponse(payload: unknown): payload is RunResponse {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.reply === "string" &&
    typeof candidate.customer_id === "string" &&
    typeof candidate.session_id === "string" &&
    typeof candidate.trace_id === "string" &&
    Array.isArray(candidate.knowledge_search_results) &&
    candidate.knowledge_search_results.every(isKnowledgeResult) &&
    Array.isArray(candidate.memory_events) &&
    ["completed", "not_completed", "responded"].includes(
      String(candidate.status),
    )
  );
}

function apiError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "请求失败";
  const detail = (payload as Record<string, unknown>).detail;
  if (detail === "llm_not_configured") return "模型尚未配置，请检查根目录 .env";
  if (detail === "llm_provider_failed") return "模型服务暂时不可用，请稍后重试";
  return typeof detail === "string" ? detail : "请求失败";
}

export default function PlaygroundPage() {
  const [customerId, setCustomerId] = useState("demo-customer");
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [sessionId, setSessionId] = useState<string>();
  const [traceId, setTraceId] = useState<string>();
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgeResult[]>(
    [],
  );
  const [memoryEvents, setMemoryEvents] = useState<MemoryEvent[]>([]);
  const nextId = useRef(1);

  async function sendMessage() {
    const message = question.trim();
    if (!message || sending) return;

    setQuestion("");
    setError(undefined);
    setSending(true);
    setMessages((current) => [
      ...current,
      { id: nextId.current++, role: "user", content: message },
    ]);

    try {
      const response = await fetch(`${API_BASE_URL}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, session_id: sessionId }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(apiError(payload));
      if (!isRunResponse(payload))
        throw new Error("服务返回了不完整的运行结果");

      setMessages((current) => [
        ...current,
        { id: nextId.current++, role: "assistant", content: payload.reply },
      ]);
      setCustomerId(payload.customer_id);
      setSessionId(payload.session_id);
      setTraceId(payload.trace_id);
      setKnowledgeResults(payload.knowledge_search_results);
      setMemoryEvents(payload.memory_events);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请求失败");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="support-workspace">
      <SellerNavigation active="playground" />
      <div className="support-layout support-layout-thin">
        <main id="main-content" className="support-thread">
          <header className="support-thread-header">
            <div>
              <h1>客服会话</h1>
              <p>消息直接发送给本地 FastAPI Agent</p>
            </div>
            <span className="support-thread-status" role="status">
              <i data-active={sending} />
              {sending ? "运行中" : "就绪"}
            </span>
          </header>

          <section
            className="support-chat-history"
            role="log"
            aria-live="polite"
            aria-busy={sending}
          >
            {messages.length === 0 ? (
              <div className="support-welcome">
                <span>Agent 已就绪</span>
                <h3>从一条客户消息开始</h3>
                <p>
                  同一 session 的后续消息会由 SQLiteSession 自动带回上下文。
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <article
                  className={`support-message ${message.role}`}
                  key={message.id}
                >
                  <div className="support-message-role">
                    {message.role === "user" ? "用户" : "Chatty"}
                  </div>
                  <div className="support-message-content">
                    {message.content}
                  </div>
                </article>
              ))
            )}
            {sending ? (
              <div className="support-typing">Chatty 正在回复…</div>
            ) : null}
            {error ? <p role="alert">请求失败：{error}</p> : null}
          </section>

          <div className="support-composer">
            <form
              className="support-composer-box"
              aria-label="发送客户消息"
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}
            >
              <Textarea
                aria-label="客户消息"
                value={question}
                placeholder="输入客户原话…"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              <Button
                className="support-send-button"
                size="icon"
                type="submit"
                aria-label="发送"
                disabled={!question.trim() || sending}
              >
                <Send aria-hidden="true" />
              </Button>
            </form>
            <div className="support-composer-footer">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <span>{question.length} 字</span>
            </div>
          </div>
        </main>

        <aside className="support-context" aria-label="运行详情">
          <section className="support-context-section">
            <div className="support-section-heading">
              <h2>运行详情</h2>
            </div>
            <dl className="support-runtime-list">
              <div>
                <dt>customer_id</dt>
                <dd>{customerId}</dd>
              </div>
              <div>
                <dt>session_id</dt>
                <dd>{sessionId ?? "尚未建立"}</dd>
              </div>
              <div>
                <dt>trace_id</dt>
                <dd>{traceId ?? "尚未运行"}</dd>
              </div>
            </dl>
          </section>
          {knowledgeResults.length > 0 ? (
            <section
              className="support-context-section"
              aria-labelledby="knowledge-results-heading"
            >
              <div className="support-section-heading">
                <h2 id="knowledge-results-heading">知识检索结果</h2>
              </div>
              {knowledgeResults.map((result) => (
                <article key={result.id} className="support-runtime-list">
                  <strong>{result.title}</strong>
                  <p>{result.summary}</p>
                  <small>{result.source}</small>
                </article>
              ))}
            </section>
          ) : null}
          <section
            className="support-context-section"
            aria-labelledby="memory-events-title"
          >
            <div className="support-section-heading">
              <h2 id="memory-events-title">Memory Tool</h2>
            </div>
            {memoryEvents.length === 0 ? (
              <p>本次运行未使用客户 Memory。</p>
            ) : (
              memoryEvents.map((event, eventIndex) => (
                <div key={event.tool + "-" + eventIndex}>
                  <strong>{event.tool}</strong>
                  {event.memories.length === 0 ? (
                    <p>未找到匹配事实</p>
                  ) : (
                    event.memories.map((memory) => (
                      <article key={memory.memory_id}>
                        <p>{memory.fact}</p>
                        <small>来源 {memory.source_id}</small>
                      </article>
                    ))
                  )}
                </div>
              ))
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
