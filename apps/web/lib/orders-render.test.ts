import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/orders",
});

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  self: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  MutationObserver: {
    configurable: true,
    value: dom.window.MutationObserver,
  },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: {
    configurable: true,
    value: true,
    writable: true,
  },
});

const { cleanup, render, screen } = await import("@testing-library/react");
const { default: OrdersPage } = await import("../app/orders/page");

test("orders page renders FastAPI loading, success, empty, and error states", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    await pending;
    return Response.json([
      {
        id: "order-1",
        customer_id: "customer-1",
        session_id: "session-1",
        product_id: "SUIT-001",
        product_name: "黑色双排扣西装",
        size: "L",
        fulfillment_mode: "rental",
        quantity: 1,
        start_date: "2026-08-01",
        end_date: "2026-08-03",
        amount_cents: 76000,
        status: "confirmed",
        channel: "Chatty",
        address: "上海市静安区",
        risk: "无",
        created_at: "2026-07-19T08:00:00Z",
        updated_at: "2026-07-19T08:01:00Z",
        events: [
          {
            id: 1,
            event_type: "created",
            description: "订单已创建",
            created_at: "2026-07-19T08:00:00Z",
          },
          {
            id: 2,
            event_type: "confirmed",
            description: "订单已确认",
            created_at: "2026-07-19T08:01:00Z",
          },
        ],
      },
    ]);
  };

  render(React.createElement(OrdersPage));
  assert.match(screen.getByRole("status").textContent ?? "", /正在读取订单/);
  release?.();
  assert.equal((await screen.findAllByText("order-1")).length, 2);
  assert.ok(screen.getByText("订单已确认"));
  assert.equal(screen.getAllByText("黑色双排扣西装").length, 2);
  cleanup();

  globalThis.fetch = async () => Response.json([]);
  render(React.createElement(OrdersPage));
  await screen.findByText("暂无订单");
  cleanup();

  globalThis.fetch = async () => Response.json({}, { status: 503 });
  render(React.createElement(OrdersPage));
  await screen.findByRole("alert");
  assert.match(screen.getByRole("alert").textContent ?? "", /无法读取订单/);

  cleanup();
  dom.window.close();
});
