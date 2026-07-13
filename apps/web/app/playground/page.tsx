"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ImagePlus, Search, Send } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { SellerNavigation } from "../components/seller/SellerNavigation";
import { SELLER_ORDERS } from "../components/seller/orderData";
import {
  isApiErrorResponse,
  isPlaygroundHistoryResponse,
  isPlaygroundResponse,
  type HarnessTrace,
  type PlaygroundHistoryMessage,
  type PlaygroundResponse,
} from "@rental/shared/browser";
import type { ConversationControlApiView } from "@/lib/control-plane-read-model";

type ChatTurn = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  trace?: HarnessTrace;
  traceId?: string;
  sessionId?: string;
  terminality?: string;
  status?: string;
  runId?: string;
};

const PRODUCT_ID_BY_ORDER_ID: Record<string, string> = {
  "ORDER-TEST-1001": "SUIT-001",
  "ORD-20260703-018": "DRESS-001",
  "ORD-20260703-006": "SUIT-002",
};

const PLAYGROUND_ERROR_MESSAGES = {
  llm_not_configured: "模型尚未配置，请检查仓库根目录的 .env",
  llm_provider_failed: "模型服务暂时不可用，请稍后重试",
  workflow_conflict: "当前会话仍在处理中，请稍后重试",
  unauthorized: "当前请求未通过访问校验",
  invalid_input: "消息内容不符合要求",
} as const;

const EMPTY_TURNS: ChatTurn[] = [];

/** Converts API error codes into actionable seller-facing messages. */
function playgroundErrorMessage(payload: unknown) {
  if (!isApiErrorResponse(payload)) return "请求失败";
  return (
    PLAYGROUND_ERROR_MESSAGES[
      payload.error as keyof typeof PLAYGROUND_ERROR_MESSAGES
    ] ?? payload.error
  );
}

function historyMessageToTurn(message: PlaygroundHistoryMessage): ChatTurn {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    traceId: message.traceId,
    sessionId: message.sessionId,
  };
}

/** Renders the seller-facing customer service workspace. */
export default function CustomerServicePage() {
  const [selectedOrderId, setSelectedOrderId] = useState(SELLER_ORDERS[0].id);
  const [question, setQuestion] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [turnsByConversation, setTurnsByConversation] = useState<
    Record<string, ChatTurn[]>
  >({});
  const [status, setStatus] = useState("等待客户消息");
  const [sending, setSending] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [controlPlane, setControlPlane] =
    useState<ConversationControlApiView>();
  const [controlPlaneError, setControlPlaneError] = useState<string>();
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement>(null);

  const selectedOrder =
    SELLER_ORDERS.find((order) => order.id === selectedOrderId) ??
    SELLER_ORDERS[0];
  const productId = PRODUCT_ID_BY_ORDER_ID[selectedOrder.id] ?? "SUIT-001";
  const conversationId = `${selectedOrder.customer}:${productId}`;
  const turns = turnsByConversation[conversationId] ?? EMPTY_TURNS;
  const visibleOrders = SELLER_ORDERS.filter((order) =>
    `${order.customer} ${order.product} ${order.channel}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, sending]);

  useEffect(() => {
    const controller = new AbortController();
    async function hydrateConversation() {
      setHistoryLoading(true);
      setStatus("正在加载会话记录");
      setControlPlaneError(undefined);
      try {
        const [historyResponse, controlResponse] = await Promise.all([
          fetch(
            `/api/playground?conversationId=${encodeURIComponent(conversationId)}`,
            { signal: controller.signal },
          ),
          fetch(
            `/api/control-plane?conversationId=${encodeURIComponent(conversationId)}&customerId=${encodeURIComponent(selectedOrder.customer)}`,
            { signal: controller.signal },
          ),
        ]);
        const history: unknown = await historyResponse.json();
        if (!historyResponse.ok || !isPlaygroundHistoryResponse(history)) {
          throw new Error("服务返回了不完整的会话记录");
        }
        const hydratedTurns = history.messages.map(historyMessageToTurn);
        setTurnsByConversation((current) => ({
          ...current,
          [conversationId]: hydratedTurns,
        }));
        if (controlResponse.ok) {
          setControlPlane(
            (await controlResponse.json()) as ConversationControlApiView,
          );
        } else {
          setControlPlane(undefined);
          setControlPlaneError("控制面状态读取失败");
        }
        setStatus(
          history.hasEarlierMessages
            ? "已恢复最近 100 轮，较早记录保留在数据库中"
            : hydratedTurns.length
              ? "会话记录已恢复"
              : "等待客户消息",
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setControlPlane(undefined);
        setControlPlaneError("会话记录读取失败");
        setStatus(
          error instanceof Error ? `加载失败：${error.message}` : "加载失败",
        );
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    }
    void hydrateConversation();
    return () => controller.abort();
  }, [conversationId, selectedOrder.customer]);

  /** Selects a customer queue item; persisted history is hydrated by conversation id. */
  function selectOrder(orderId: string) {
    setSelectedOrderId(orderId);
    setQuestion("");
    setImageUrl("");
    setControlPlane(undefined);
    setControlPlaneError(undefined);
  }

  function appendTurns(targetConversationId: string, additions: ChatTurn[]) {
    setTurnsByConversation((current) => ({
      ...current,
      [targetConversationId]: [
        ...(current[targetConversationId] ?? []),
        ...additions,
      ],
    }));
  }

  /** Sends a customer message through the harness using product-safe defaults. */
  async function sendMessage(text: string) {
    const trimmed = text.trim();
    const attachedImageUrl = imageUrl.trim();
    if ((!trimmed && !attachedImageUrl) || sending || historyLoading) return;
    const targetConversationId = conversationId;

    const visibleContent = attachedImageUrl
      ? `${trimmed || "发送了一张图片"}\n图片：${attachedImageUrl}`
      : trimmed;
    appendTurns(targetConversationId, [
      {
        id: `local:${nextId.current++}`,
        role: "user",
        content: visibleContent,
      },
    ]);
    setQuestion("");
    setImageUrl("");
    setSending(true);
    setStatus("Chatty 正在处理客户消息");

    try {
      const response = await fetch("/api/playground", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: selectedOrder.customer,
          productId,
          conversationId,
          question: trimmed,
          imageUrl: attachedImageUrl || undefined,
          sessionContext: {
            channel: selectedOrder.channel,
            sellerMode: true,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(playgroundErrorMessage(data));
      if (!isPlaygroundResponse(data))
        throw new Error("服务返回了不完整的会话结果");

      const reply: PlaygroundResponse = data;
      // The control-plane read only feeds the secondary runtime inspector panel.
      // Its failure (incl. a network rejection) must never discard the reply that
      // already succeeded above, so keep it in its own try/catch.
      try {
        const controlResponse = await fetch(
          `/api/control-plane?conversationId=${encodeURIComponent(conversationId)}&customerId=${encodeURIComponent(selectedOrder.customer)}&runId=${encodeURIComponent(reply.runId)}`,
        );
        if (controlResponse.ok) {
          setControlPlane(
            (await controlResponse.json()) as ConversationControlApiView,
          );
          setControlPlaneError(undefined);
        } else {
          setControlPlane(undefined);
          setControlPlaneError("控制面状态读取失败");
        }
      } catch {
        setControlPlane(undefined);
        setControlPlaneError("控制面状态读取失败");
      }
      appendTurns(targetConversationId, [
        {
          id: `local:${nextId.current++}`,
          role: "assistant",
          content: reply.reply || "（无回复）",
          trace: reply.harnessTrace,
          traceId: reply.traceId,
          sessionId: reply.sessionId,
          terminality: reply.terminality,
          status: reply.status,
          runId: reply.runId,
        },
      ]);
      setStatus(reply.terminality === "close" ? "本轮已完成" : "等待继续跟进");
    } catch (error) {
      const message =
        error instanceof TypeError
          ? "无法连接本地服务，请确认 pnpm dev 正在运行"
          : error instanceof Error
            ? error.message
            : String(error);
      appendTurns(targetConversationId, [
        {
          id: `local:${nextId.current++}`,
          role: "system",
          content: `请求失败：${message}`,
        },
      ]);
      setStatus(`请求失败：${message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="support-workspace">
      <SellerNavigation active="playground" />
      <div className="support-layout">
        <aside className="support-inbox" aria-label="会话列表">
          <header className="support-inbox-header">
            <div>
              <h1>客服会话</h1>
              <span>{SELLER_ORDERS.length} 个待处理会话</span>
            </div>
          </header>
          <label className="support-search">
            <Search aria-hidden="true" />
            <input
              aria-label="搜索会话"
              value={search}
              placeholder="搜索客户或商品"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="support-inbox-tabs" aria-label="会话筛选">
            <button className="active" type="button">
              待处理
            </button>
            <button type="button">全部会话</button>
          </div>
          <div className="support-conversation-list">
            {visibleOrders.map((order) => (
              <button
                aria-pressed={order.id === selectedOrder.id}
                data-active={order.id === selectedOrder.id}
                key={order.id}
                type="button"
                disabled={sending}
                onClick={() => selectOrder(order.id)}
              >
                <span className="support-conversation-topline">
                  <strong>{order.customer}</strong>
                  <time>{order.updatedAt}</time>
                </span>
                <span className="support-conversation-product">
                  {order.product}
                </span>
                <small>
                  {order.channel} · {order.status}
                </small>
              </button>
            ))}
          </div>
        </aside>

        <main className="support-thread" id="main-content">
          <header className="support-thread-header">
            <div>
              <h2>{selectedOrder.customer}</h2>
              <p>
                {selectedOrder.channel} · {selectedOrder.product}
              </p>
            </div>
            <div
              className="support-thread-status"
              aria-live="polite"
              role="status"
            >
              <i data-active={sending} />
              {status}
            </div>
          </header>

          <div
            aria-busy={sending || historyLoading}
            aria-label="实时会话记录"
            aria-live="polite"
            className="support-chat-history"
            role="log"
          >
            {turns.length === 0 ? (
              <div className="support-welcome">
                <span>会话已就绪</span>
                <h3>从客户原话开始</h3>
                <p>Chatty 会结合商品、租期和订单规则生成回复建议。</p>
              </div>
            ) : (
              turns.map((turn) => <LegacyMessage key={turn.id} turn={turn} />)
            )}
            {historyLoading ? (
              <div className="support-typing">正在恢复会话记录…</div>
            ) : sending ? (
              <div className="support-typing">Chatty 正在整理回复…</div>
            ) : null}
            <div ref={bottomRef} />
          </div>

          <div className="support-composer">
            <form
              className="support-composer-box"
              aria-label="发送客户消息"
              onSubmit={(event) => {
                event.preventDefault();
                sendMessage(question);
              }}
            >
              <details className="support-attachment-details">
                <summary aria-label="添加客户图片">
                  <ImagePlus data-icon="inline-start" />
                </summary>
                <label className="support-image-url">
                  客户图片链接
                  <Input
                    value={imageUrl}
                    placeholder="粘贴客户发来的图片链接"
                    onChange={(event) => setImageUrl(event.target.value)}
                  />
                </label>
              </details>
              <Textarea
                aria-label="客户消息"
                value={question}
                placeholder="输入客户原话…"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage(question);
                  }
                }}
              />
              <Button
                className="support-send-button"
                size="icon"
                type="submit"
                aria-label="发送"
                disabled={
                  (!question.trim() && !imageUrl.trim()) ||
                  sending ||
                  historyLoading
                }
              >
                <Send data-icon="inline-start" />
              </Button>
            </form>
            <div className="support-composer-footer">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <span>{question.length} 字</span>
            </div>
          </div>
        </main>

        <aside className="support-context" aria-label="会话上下文">
          <section className="support-context-section">
            <div className="support-section-heading">
              <h2>订单信息</h2>
              <span className="support-order-status">
                {selectedOrder.status}
              </span>
            </div>
            <dl className="support-data-list">
              <div>
                <dt>商品</dt>
                <dd>{selectedOrder.product}</dd>
              </div>
              <div>
                <dt>租期</dt>
                <dd>{selectedOrder.period}</dd>
              </div>
              <div>
                <dt>尺码</dt>
                <dd>{selectedOrder.size}</dd>
              </div>
              <div>
                <dt>金额</dt>
                <dd>{selectedOrder.amount}</dd>
              </div>
            </dl>
            {selectedOrder.risk !== "无" ? (
              <p className="support-risk">{selectedOrder.risk}</p>
            ) : null}
          </section>

          <section className="support-context-section">
            <div className="support-section-heading">
              <h2>客户资料</h2>
            </div>
            <strong className="support-customer-name">
              {selectedOrder.customer}
            </strong>
            <p className="support-address">{selectedOrder.address}</p>
            <ul className="support-notes">
              {selectedOrder.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>

          <details className="support-runtime">
            <summary>
              <span>
                <i data-active={Boolean(controlPlane?.workflow.leaseOwner)} />
                运行详情
              </span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <div className="support-runtime-body" aria-label="Harness 控制面">
              {controlPlaneError ? (
                <p role="alert">{controlPlaneError}</p>
              ) : null}
              <dl className="support-runtime-list">
                <div>
                  <dt>状态</dt>
                  <dd>{controlPlane?.workflow.displayState ?? "尚未运行"}</dd>
                </div>
                <div>
                  <dt>排队</dt>
                  <dd>
                    {controlPlane ? `${controlPlane.queueDepth} 条` : "—"}
                  </dd>
                </div>
                <div>
                  <dt>最近心跳</dt>
                  <dd>{controlPlane?.workflow.heartbeatAt ?? "—"}</dd>
                </div>
                <div>
                  <dt>检查点</dt>
                  <dd>版本 {controlPlane?.checkpoint?.version ?? 0}</dd>
                </div>
              </dl>
              {(controlPlane?.workflowEvents.length ?? 0) > 0 ? (
                <ol className="support-event-list">
                  {controlPlane?.workflowEvents.map((event) => (
                    <li key={`${event.sequence}-${event.type}`}>
                      <span>#{event.sequence}</span>
                      {event.type}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="support-runtime-empty">
                  完成一次会话后可查看运行记录。
                </p>
              )}
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}

/** Renders one chat message in the seller transcript style. */
function LegacyMessage({ turn }: { turn: ChatTurn }) {
  return (
    <article className={`support-message ${turn.role}`}>
      <div className="support-message-role">
        {turn.role === "user"
          ? "用户"
          : turn.role === "assistant"
            ? "客服"
            : "系统"}
      </div>
      <div className="support-message-content">{turn.content}</div>
      {turn.traceId ? (
        <p>
          {turn.status ? `状态：${turn.status} · ` : ""}会话 {turn.sessionId}
        </p>
      ) : null}
    </article>
  );
}
