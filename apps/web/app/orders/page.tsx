"use client";

import { useEffect, useMemo, useState } from "react";
import { SellerNavigation } from "../components/seller/SellerNavigation";
import { WorkspaceHeader } from "../components/seller/WorkspaceHeader";

const API_BASE_URL = "http://127.0.0.1:8000";

type OrderEvent = {
  id: number;
  event_type: "created" | "confirmed" | "cancelled";
  description: string;
  created_at: string;
};

type Order = {
  id: string;
  customer_id: string;
  session_id: string;
  product_id: string;
  product_name: string;
  size: string;
  fulfillment_mode: "rental" | "buyout";
  quantity: number;
  start_date: string | null;
  end_date: string | null;
  amount_cents: number;
  status: "pending" | "confirmed" | "cancelled";
  channel: string;
  address: string;
  risk: string;
  created_at: string;
  updated_at: string;
  events: OrderEvent[];
};

const STATUS_LABELS: Record<Order["status"], string> = {
  pending: "待确认",
  confirmed: "已确认",
  cancelled: "已取消",
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const abortController = new AbortController();

    async function loadOrders() {
      try {
        const response = await fetch(`${API_BASE_URL}/orders`, {
          signal: abortController.signal,
        });
        if (!response.ok)
          throw new Error("无法读取订单，请确认 FastAPI 已启动");
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) throw new Error("订单接口返回格式错误");
        const nextOrders = payload as Order[];
        setOrders(nextOrders);
        setSelectedId(nextOrders[0]?.id);
      } catch (caught) {
        if (!abortController.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "无法读取订单");
        }
      } finally {
        if (!abortController.signal.aborted) setLoading(false);
      }
    }

    void loadOrders();
    return () => abortController.abort();
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return orders;
    return orders.filter((order) =>
      [
        order.id,
        order.customer_id,
        order.product_name,
        STATUS_LABELS[order.status],
      ].some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [orders, query]);
  const selected = orders.find((order) => order.id === selectedId) ?? orders[0];

  return (
    <main className="orders-page" id="main-content">
      <SellerNavigation active="orders" />
      <WorkspaceHeader eyebrow="Order ops · SQLite" title="订单跟进" />

      {loading ? <p role="status">正在读取订单…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!loading && !error && orders.length === 0 ? <p>暂无订单</p> : null}

      {!loading && !error && selected ? (
        <div className="orders-layout">
          <aside className="orders-list">
            <div className="orders-filter">
              <input
                aria-label="搜索订单"
                placeholder="搜索订单号 / 客户 / 商品"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="button" onClick={() => setQuery("")}>
                重置
              </button>
            </div>
            <div className="order-row-list">
              {filtered.map((order) => (
                <button
                  className={`order-row ${order.id === selected.id ? "active" : ""}`}
                  key={order.id}
                  type="button"
                  onClick={() => setSelectedId(order.id)}
                >
                  <div>
                    <strong>{order.id}</strong>
                    <span>{STATUS_LABELS[order.status]}</span>
                  </div>
                  <p>{order.product_name}</p>
                  <div className="order-row-meta">
                    <span>{order.customer_id}</span>
                    <span>{formatDateTime(order.updated_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className="order-detail">
            <div className="order-detail-head">
              <div>
                <p>
                  {selected.channel} · {selected.customer_id}
                </p>
                <h2>{selected.id}</h2>
              </div>
              <span>{STATUS_LABELS[selected.status]}</span>
            </div>

            <div className="order-kpis">
              <div>
                <span>商品</span>
                <strong>{selected.product_name}</strong>
              </div>
              <div>
                <span>模式</span>
                <strong>
                  {selected.fulfillment_mode === "rental" ? "租赁" : "买断"}
                </strong>
              </div>
              <div>
                <span>档期</span>
                <strong>{periodLabel(selected)}</strong>
              </div>
              <div>
                <span>尺码 / 数量</span>
                <strong>
                  {selected.size} · {selected.quantity}
                </strong>
              </div>
              <div>
                <span>金额</span>
                <strong>{formatAmount(selected.amount_cents)}</strong>
              </div>
            </div>

            <div className="order-sections">
              <section>
                <h3>客户与订单信息</h3>
                <div className="info-list">
                  <div>
                    <span>客户</span>
                    <strong>{selected.customer_id}</strong>
                  </div>
                  <div>
                    <span>地址</span>
                    <strong>{selected.address}</strong>
                  </div>
                  <div>
                    <span>风险</span>
                    <strong>{selected.risk}</strong>
                  </div>
                  <div>
                    <span>Session</span>
                    <strong>{selected.session_id}</strong>
                  </div>
                </div>
              </section>
            </div>

            <section className="order-timeline">
              <h3>订单时间线</h3>
              <ol>
                {selected.events.map((event) => (
                  <li key={event.id}>
                    <strong>{formatDateTime(event.created_at)}</strong>
                    {event.description}
                  </li>
                ))}
              </ol>
            </section>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function periodLabel(order: Order): string {
  if (order.fulfillment_mode === "buyout") return "买断";
  return `${order.start_date ?? "-"} 至 ${order.end_date ?? "-"}`;
}

function formatAmount(amountCents: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
  }).format(amountCents / 100);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
