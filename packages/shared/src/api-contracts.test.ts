import assert from "node:assert/strict";
import test from "node:test";
import { isApiErrorResponse, isPlaygroundResponse } from "./api-contracts.js";

test("playground response guard accepts the public success contract", () => {
  assert.equal(
    isPlaygroundResponse({
      reply: "已为您查询",
      traceId: "tr-1",
      runId: "run-1",
      sessionId: "sess-1",
      status: "waiting_for_user",
      terminality: "reply_and_wait",
      harnessTrace: {},
    }),
    true,
  );
});

test("playground response guard rejects incomplete success-shaped JSON", () => {
  assert.equal(isPlaygroundResponse({ reply: "only text" }), false);
  assert.equal(isApiErrorResponse({ error: "llm_provider_failed" }), true);
});
