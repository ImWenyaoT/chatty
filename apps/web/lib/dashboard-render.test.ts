import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1:3000/dashboard",
});

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  self: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
});

const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { default: DashboardPage } = await import("../app/dashboard/page");

const traces = [
  {
    trace_id: "trace-new",
    session_id: "session-new",
    status: "completed",
    summary: "Agent run completed",
    model_id: "deepseek-v4-pro",
    span_types: ["agent", "generation", "function"],
    created_at: "2026-07-19T08:01:00.000Z",
    updated_at: "2026-07-19T08:01:00.125Z",
    duration_ms: 125,
    business_outcome: "verified",
    completion_evidence: "confirm_order:order-1:confirmed",
    knowledge_sources: ["seller-policy://rental-period"],
    memory_sources: ["trace-memory-source"],
    support_request_id: null,
    spans: [],
  },
  {
    trace_id: "trace-handoff",
    session_id: "session-handoff",
    status: "completed",
    summary: "Agent run completed",
    model_id: "deepseek-v4-pro",
    span_types: ["function"],
    created_at: "2026-07-19T08:00:00.000Z",
    updated_at: "2026-07-19T08:00:00.040Z",
    duration_ms: 40,
    business_outcome: "not_completed",
    completion_evidence: "handoff:support-1",
    knowledge_sources: [],
    memory_sources: [],
    support_request_id: "support-1",
    spans: [],
  },
];

test("dashboard renders loading, real traces, selection, empty, and error states", async () => {
  const requestedUrls: string[] = [];
  let failDetail = false;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/traces")) {
      await pending;
      return Response.json({
        traces,
        order_status_counts: { pending: 1, confirmed: 2, cancelled: 3 },
      });
    }
    if (failDetail) return Response.json({}, { status: 503 });
    const trace = traces.find((item) => url.endsWith(item.trace_id));
    return Response.json({
      ...trace,
      spans: [
        {
          span_id: `span-${trace?.trace_id}`,
          trace_id: trace?.trace_id,
          parent_id: null,
          span_type: "function",
          status: "completed",
          summary:
            trace?.trace_id === "trace-handoff"
              ? "create_handoff created receipt"
              : "confirm_order span completed",
          started_at: trace?.created_at,
          ended_at: trace?.updated_at,
          duration_ms: trace?.duration_ms,
          error: null,
        },
      ],
    });
  };

  render(React.createElement(DashboardPage));
  assert.match(screen.getByRole("status").textContent ?? "", /正在读取 Trace/);
  release?.();
  await screen.findByText("session-new");
  assert.ok(await screen.findByText("confirm_order:order-1:confirmed"));
  assert.ok(screen.getByText("seller-policy://rental-period"));
  assert.ok(screen.getByText("trace-memory-source"));
  assert.ok(screen.getByText("confirm_order span completed"));
  assert.ok(screen.getByText("已确认 2"));

  fireEvent.click(screen.getByRole("button", { name: /trace-handoff/ }));
  await screen.findByText("create_handoff created receipt");
  assert.ok(screen.getAllByText("support-1").length >= 1);

  failDetail = true;
  fireEvent.click(screen.getByRole("button", { name: "查看 trace-new" }));
  assert.match(
    (await screen.findByRole("alert")).textContent ?? "",
    /无法读取 Trace 详情/,
  );
  assert.equal(screen.queryByText("create_handoff created receipt"), null);
  assert.equal(screen.queryByText("support-1"), null);
  assert.ok(
    requestedUrls.every((url) =>
      url.startsWith("http://127.0.0.1:8000/traces"),
    ),
  );
  cleanup();

  globalThis.fetch = async () =>
    Response.json({
      traces: [],
      order_status_counts: { pending: 0, confirmed: 0, cancelled: 0 },
    });
  render(React.createElement(DashboardPage));
  await screen.findByText("暂无 Agent Run");
  cleanup();

  globalThis.fetch = async () => Response.json({}, { status: 503 });
  render(React.createElement(DashboardPage));
  assert.match(
    (await screen.findByRole("alert")).textContent ?? "",
    /无法读取 Trace/,
  );
  cleanup();
  dom.window.close();
});
