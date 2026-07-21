import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MemoryStore,
  SessionCustomerMismatchError,
  SessionNotFoundError,
  SupportRequestIdempotencyConflictError,
  SupportRequestStore,
  TraceStore,
} from "../src/stores.js";

function withDatabase(run: (databasePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "chatty-stores-"));
  try {
    run(join(directory, "chatty.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("memory keeps session ownership and customer-scoped lexical fallback", () => {
  withDatabase((databasePath) => {
    const store = new MemoryStore(databasePath);
    try {
      store.bindSession("session-1", "customer-1");
      store.requireSession("session-1", "customer-1");
      assert.throws(
        () => store.bindSession("session-1", "customer-2"),
        SessionCustomerMismatchError,
      );
      assert.throws(
        () => store.requireSession("missing", "customer-1"),
        SessionNotFoundError,
      );

      const size = store.save("customer-1", "常穿 L 码上装", "trace-size");
      store.save("customer-1", "偏好深色、低调的商务风格", "trace-style");
      store.save("customer-2", "常穿 L 码上装", "trace-other");

      assert.deepEqual(store.search("customer-1", "L 码", 10), [size]);
      const related = store.search(
        "customer-1",
        "尺码 风格偏好 穿衣风格 服装尺码",
        5,
      );
      assert.deepEqual(
        new Set(related.map((memory) => memory.fact)),
        new Set(["常穿 L 码上装", "偏好深色、低调的商务风格"]),
      );
      assert.equal(
        store
          .search("customer-2", "商务风格", 10)
          .some((item) => item.fact.includes("深色")),
        false,
      );
    } finally {
      store.close();
    }
  });
});

test("support request create is idempotent and detects conflicting evidence", () => {
  withDatabase((databasePath) => {
    const store = new SupportRequestStore(databasePath);
    const input = {
      customer_id: "customer-1",
      session_id: "session-1",
      reason: " 需要授权 ",
      context: " 退款审批 ",
      model_context: " 人工判断 ",
      prior_actions: ["check_order:ok"],
      idempotency_key: "request-1:handoff",
    };
    try {
      const first = store.create(input);
      const replay = store.create(input);
      assert.equal(replay.id, first.id);
      assert.equal(replay.reason, "需要授权");
      assert.deepEqual(store.get(first.id), first);
      assert.deepEqual(store.listAll(), [first]);
      assert.throws(
        () => store.create({ ...input, reason: "不同原因" }),
        SupportRequestIdempotencyConflictError,
      );
    } finally {
      store.close();
    }
  });
});

test("trace store preserves safe summaries, spans and outcome evidence", () => {
  withDatabase((databasePath) => {
    const store = new TraceStore(databasePath);
    try {
      store.start("trace-1", "session-1", "model-1");
      store.recordSpan({
        span_id: "span-1",
        trace_id: "trace-1",
        parent_id: null,
        span_type: "generation",
        failed: false,
        name: "model-1",
        started_at: "2026-07-20T10:00:00.000Z",
        ended_at: "2026-07-20T10:00:00.125Z",
      });
      store.recordToolEvent(
        "trace-1",
        "completed",
        "create_handoff created receipt",
      );
      store.recordOutcome("trace-1", {
        business_outcome: "not_completed",
        completion_evidence: "handoff:support-1",
        knowledge_sources: ["source-b", "source-a", "source-a"],
        memory_sources: ["memory-source"],
        support_request_id: "support-1",
      });
      store.complete("trace-1");

      const trace = store.get("trace-1");
      assert.equal(trace?.status, "completed");
      assert.equal(trace?.business_outcome, "not_completed");
      assert.deepEqual(trace?.knowledge_sources, ["source-a", "source-b"]);
      assert.deepEqual(store.spanTypes("trace-1"), ["generation", "tool"]);
      assert.equal(store.spans("trace-1")[0]?.duration_ms, 125);
      assert.equal(store.listRecent()[0]?.trace_id, "trace-1");
    } finally {
      store.close();
    }
  });
});

test("trace store upgrades the previous SQLite schema", () => {
  withDatabase((databasePath) => {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE local_traces (
          trace_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          model_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE local_spans (
          span_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          parent_id TEXT,
          span_type TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO local_traces
          (trace_id, session_id, status, summary, model_id)
      VALUES ('trace-legacy', 'session-legacy', 'completed',
              'Agent run completed', 'legacy-model');
      INSERT INTO local_spans
          (span_id, trace_id, parent_id, span_type, status, summary)
      VALUES ('span-legacy', 'trace-legacy', NULL, 'agent', 'completed',
              'agent span completed');
    `);
    database.close();

    const store = new TraceStore(databasePath);
    try {
      assert.deepEqual(store.get("trace-legacy")?.knowledge_sources, []);
      assert.deepEqual(store.get("trace-legacy")?.memory_sources, []);
      assert.equal(store.spans("trace-legacy")[0]?.started_at, null);
    } finally {
      store.close();
    }
  });
});
