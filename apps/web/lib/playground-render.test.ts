import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/playground",
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

const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { default: PlaygroundPage } = await import("../src/pages/PlaygroundPage");

test("playground renders loading, success, session continuity, and errors", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (requests.length === 1) {
      await firstPending;
      return Response.json({
        reply: "第一条回复",
        customer_id: "demo-customer",
        session_id: "session-1",
        trace_id: "trace-1",
        request_id: "request-1",
        status: "needs_human",
        business_outcome: "not_completed",
        completion_evidence: "handoff:support-1",
        needs_human: true,
        support_request_id: "support-1",
        knowledge_search_results: [
          {
            id: "policy-rental-period-1",
            title: "租期计算",
            summary: "租期从签收当天开始。",
            body: "租期从签收当天开始，到约定归还日期寄回即可。",
            source: "seller-policy://rental-period",
            tags: ["租赁"],
          },
        ],
        memory_events: [
          {
            tool: "search_customer_memory",
            memories: [
              {
                memory_id: "memory-1",
                customer_id: "demo-customer",
                fact: "客户对羊毛过敏",
                source_id: "trace-memory-source",
                created_at: "2026-07-19T08:00:00.000Z",
              },
            ],
          },
        ],
      });
    }
    return Response.json({ detail: "llm_provider_failed" }, { status: 503 });
  };

  render(React.createElement(PlaygroundPage));
  const input = screen.getByLabelText("客户消息");

  fireEvent.change(input, { target: { value: "第一条消息" } });
  fireEvent.click(screen.getByLabelText("发送"));
  assert.equal(
    screen.getByRole("status").textContent?.includes("运行中"),
    true,
  );
  assert.equal(screen.getByRole("log").getAttribute("aria-busy"), "true");

  releaseFirst?.();
  await screen.findByText("第一条回复");
  assert.equal(screen.getByText("session-1").textContent, "session-1");
  assert.equal(screen.getByText("trace-1").textContent, "trace-1");
  assert.equal(screen.getByText("request-1").textContent, "request-1");
  assert.equal(
    screen.getByText("handoff:support-1").textContent,
    "handoff:support-1",
  );
  assert.equal(screen.getByText("需要人工处理").textContent, "需要人工处理");
  assert.equal(screen.getByText("support-1").textContent, "support-1");
  fireEvent.click(screen.getByRole("tab", { name: "知识" }));
  assert.equal(screen.getByText("租期计算").textContent, "租期计算");
  assert.equal(
    screen.getByRole("heading", { name: "知识检索结果" }).textContent,
    "知识检索结果",
  );
  assert.equal(
    screen.getByText("seller-policy://rental-period").textContent,
    "seller-policy://rental-period",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
  assert.equal(
    screen.getByText("客户对羊毛过敏").textContent,
    "客户对羊毛过敏",
  );
  assert.match(
    screen.getByText(/trace-memory-source/).textContent ?? "",
    /来源 trace-memory-source/,
  );
  assert.equal(
    screen.getByText("search_customer_memory").textContent,
    "search_customer_memory",
  );
  assert.deepEqual(requests[0], {
    message: "第一条消息",
  });

  fireEvent.change(input, { target: { value: "第二条消息" } });
  fireEvent.click(screen.getByLabelText("发送"));
  await screen.findByRole("alert");
  assert.match(
    screen.getByRole("alert").textContent ?? "",
    /模型服务暂时不可用/,
  );
  assert.deepEqual(requests[1], {
    message: "第二条消息",
    session_id: "session-1",
  });

  cleanup();
  dom.window.close();
});
