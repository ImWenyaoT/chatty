import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { RunResponse } from "@chatty/contracts";
import { matchEvalExpectation, readEvalCases } from "../src/eval.js";

const casesPath = resolve(import.meta.dirname, "../../../eval/cases.jsonl");

test("TypeScript validates every deterministic eval case and tool name", () => {
  const cases = readEvalCases(casesPath);
  assert.equal(cases.length, 7);
  assert.deepEqual(
    cases.map((item) => item.id),
    [
      "ordinary-response",
      "knowledge-with-source",
      "order-side-effect",
      "failed-order-completion-verification",
      "explicit-memory-provenance",
      "handoff-receipt",
      "industry-research-to-content",
    ],
  );
});

test("invalid eval JSONL reports its exact line without partial acceptance", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-eval-"));
  const path = join(directory, "cases.jsonl");
  try {
    writeFileSync(path, '{"id":"ok","runs":[]}\n{"id":"bad","runs":[}\n');
    assert.throws(() => readEvalCases(path), /invalid eval JSONL on line 2/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("eval matcher preserves completion, source, memory and handoff assertions", () => {
  const body: RunResponse = {
    reply: "已创建支持请求",
    customer_id: "customer-1",
    session_id: "session-1",
    trace_id: "trace-1",
    request_id: "request-1",
    status: "needs_human",
    business_outcome: "not_completed",
    completion_evidence: "handoff:support_1",
    knowledge_search_results: [],
    memory_events: [],
    needs_human: true,
    support_request_id: "support_1",
  };
  assert.deepEqual(
    matchEvalExpectation(
      body,
      {
        status: "needs_human",
        completion_evidence_prefix: "handoff:",
        reply_contains: "支持",
        order_count: 0,
        memory_source: false,
        support_receipt: true,
      },
      { orderCount: 0, artifactCount: 0 },
    ),
    [],
  );
  assert.equal(
    matchEvalExpectation(
      body,
      { status: "completed", memory_source: true, support_receipt: false },
      { orderCount: 0, artifactCount: 0 },
    ).length,
    2,
  );
});
