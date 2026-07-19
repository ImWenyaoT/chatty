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
const { default: PlaygroundPage } = await import("../app/playground/page");

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
        session_id: "session-1",
        trace_id: "trace-1",
        status: "completed",
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
