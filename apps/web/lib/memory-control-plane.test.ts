import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createControlPlaneRepository,
  createMemoryRepository,
  openDatabase,
} from "@rental/db";
import {
  dispatchBackgroundJob,
  type BackgroundJobExecutors,
} from "./background-job-worker";

const now = "2026-07-11T00:00:00.000Z";

/** Opens a real temporary SQLite store for memory control-plane integration tests. */
function stores() {
  const db = openDatabase(
    join(mkdtempSync(join(tmpdir(), "chatty-memory-")), "harness.sqlite"),
  );
  db.prepare(
    `INSERT INTO agent_sessions
     (id, customer_id, product_id, conversation_id, status, current_step, created_at, updated_at)
     VALUES ('session-1', 'customer-1', 'SUIT-001', 'conversation-1', 'active', 'test', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO agent_traces
     (id, session_id, event_type, input_json, tool_calls_json, references_json, created_at)
     VALUES ('trace-1', 'session-1', 'agent_reply_sent', '{}', '[]', '[]', ?)`,
  ).run(now);
  const insertOrder = db.prepare(
    `INSERT INTO orders
     (id, idempotency_key, customer_id, conversation_id, product_id, size,
      fulfillment_mode, quantity, start_date, end_date, status, created_at, updated_at)
     VALUES (?, ?, 'customer-1', 'conversation-1', 'SUIT-001', 'L',
      'rental', 1, ?, ?, 'confirmed', ?, ?)`,
  );
  insertOrder.run(
    "order-1",
    "memory-order-1",
    "2026-08-01",
    "2026-08-02",
    now,
    now,
  );
  insertOrder.run(
    "order-2",
    "memory-order-2",
    "2026-08-03",
    "2026-08-04",
    now,
    now,
  );
  return {
    control: createControlPlaneRepository(db),
    memory: createMemoryRepository(db),
  };
}

/** Builds executors with only the selected memory behavior enabled. */
function memoryExecutors(
  overrides: Partial<BackgroundJobExecutors>,
): BackgroundJobExecutors {
  const unexpected = async () => {
    throw new Error("unexpected executor");
  };
  return {
    memoryExtract: overrides.memoryExtract ?? unexpected,
    memoryConsolidate: overrides.memoryConsolidate ?? unexpected,
    scheduledFollowup: unexpected,
  };
}

test("conversation extraction cooling coalesces turns and later facts schedule fresh work", () => {
  const { control } = stores();
  const first = control.scheduleMemoryExtraction({
    id: "extract-1",
    conversationId: "conversation-1",
    customerId: "customer-1",
    payload: { throughTraceId: "trace-1" },
    now,
    coolingMs: 1_000,
  });
  const second = control.scheduleMemoryExtraction({
    id: "extract-2",
    conversationId: "conversation-1",
    customerId: "customer-1",
    payload: { throughTraceId: "trace-2" },
    now: "2026-07-11T00:00:00.500Z",
    coolingMs: 1_000,
  });

  assert.equal(second.id, first.id);
  assert.deepEqual(second.payload, { throughTraceId: "trace-2" });
  assert.equal(second.dueAt, "2026-07-11T00:00:01.500Z");
  const claim = control.claimDueJob("worker-1", second.dueAt)!;
  const successor = control.scheduleMemoryExtraction({
    id: "extract-successor",
    conversationId: "conversation-1",
    customerId: "customer-1",
    payload: { throughTraceId: "trace-after-claim" },
    now: second.dueAt,
    coolingMs: 1_000,
  });
  assert.notEqual(successor.id, claim.id);
  control.finishJob(
    claim.id,
    "succeeded_no_output",
    {},
    "worker-1",
    claim.claimFence,
  );
  control.cancelJob(successor.id);
  const fresh = control.scheduleMemoryExtraction({
    id: "extract-3",
    conversationId: "conversation-1",
    customerId: "customer-1",
    payload: { throughTraceId: "trace-3" },
    now: "2026-07-11T00:00:02.000Z",
    coolingMs: 1_000,
  });
  assert.notEqual(fresh.id, first.id);
});

test("fenced extraction atomically preserves provenance, deduplicates replay, and records no-output", async () => {
  const { control } = stores();
  control.scheduleMemoryExtraction({
    id: "extract-1",
    conversationId: "conversation-1",
    customerId: "customer-1",
    payload: {},
    now,
    coolingMs: 0,
  });
  await dispatchBackgroundJob({
    control,
    workerId: "worker-1",
    now: () => new Date(now),
    executors: memoryExecutors({
      memoryExtract: async () => ({
        extraction: {
          customerId: "customer-1",
          conversationId: "conversation-1",
          productId: "product-1",
          conversationSummary: "需要 42 码",
          candidates: [
            {
              id: "candidate-1",
              sourceTraceId: "trace-1",
              category: "measurement",
              key: "shoe_size",
              value: 42,
              confidence: 0.9,
              sensitivity: "normal",
            },
          ],
        },
      }),
    }),
  });
  assert.equal(
    control.listMemoryCandidates("customer-1")[0].sourceTraceId,
    "trace-1",
  );
  assert.equal(control.getJob("extract-1")?.status, "succeeded");

  control.scheduleMemoryExtraction({
    id: "extract-2",
    conversationId: "conversation-1",
    customerId: "customer-1",
    payload: {},
    now,
    coolingMs: 0,
  });
  await dispatchBackgroundJob({
    control,
    workerId: "worker-2",
    now: () => new Date(now),
    executors: memoryExecutors({
      memoryExtract: async () => ({
        extraction: {
          customerId: "customer-1",
          conversationId: "conversation-1",
          productId: "product-1",
          conversationSummary: "需要 42 码",
          candidates: [
            {
              id: "candidate-replay",
              sourceTraceId: "trace-1",
              category: "measurement",
              key: "shoe_size",
              value: 42,
              confidence: 0.9,
              sensitivity: "normal",
            },
          ],
        },
      }),
    }),
  });
  assert.equal(control.listMemoryCandidates("customer-1").length, 1);
  assert.equal(control.getJob("extract-2")?.status, "succeeded_no_output");
});

test("global consolidation lease reclaim fences stale owner and commits promotion with summary", () => {
  const { control, memory } = stores();
  control.insertMemoryCandidate({
    id: "candidate-1",
    customerId: "customer-1",
    conversationId: "conversation-1",
    sourceTraceId: "trace-1",
    category: "preference",
    key: "color",
    value: "black",
    confidence: 0.9,
    sensitivity: "normal",
    status: "candidate",
  });
  control.enqueueJob({
    id: "consolidate-1",
    type: "memory_consolidate",
    customerId: "customer-1",
    payload: {},
    dueAt: now,
    idempotencyKey: "global-consolidation",
  });
  const stale = control.claimDueJob("stale", now, 1)!;
  control.scheduleMemoryConsolidation({
    id: "consolidate-2",
    customerId: "customer-2",
    now,
  });
  assert.equal(control.claimDueJob("parallel", now), undefined);
  const reclaimedAt = "2026-07-11T00:00:00.002Z";
  const fresh = control.claimDueJob("fresh", reclaimedAt)!;
  assert.equal(
    control.completeMemoryConsolidation(
      stale.id,
      "stale",
      stale.claimFence,
      {
        customerId: "customer-1",
        globalSummary: "旧摘要",
        promotedIds: ["candidate-1"],
        prunedIds: [],
      },
      reclaimedAt,
    ),
    false,
  );
  assert.equal(
    control.completeMemoryConsolidation(
      fresh.id,
      "fresh",
      fresh.claimFence,
      {
        customerId: "customer-1",
        globalSummary: "偏好黑色",
        promotedIds: ["candidate-1"],
        prunedIds: [],
      },
      reclaimedAt,
    ),
    true,
  );
  assert.equal(
    control.listMemoryCandidates("customer-1")[0].status,
    "promoted",
  );
  assert.equal(memory.getCustomer("customer-1")?.globalSummary, "偏好黑色");
});

test("unverified inferred preference cannot become Long-term Customer Memory", () => {
  const { control } = stores();
  control.insertMemoryCandidate({
    id: "candidate-inferred",
    customerId: "customer-1",
    conversationId: "conversation-1",
    sourceTraceId: "trace-1",
    category: "preference",
    key: "color",
    value: "black",
    confidence: 0.8,
    sensitivity: "normal",
    evidenceKind: "inferred",
    status: "candidate",
  });
  control.scheduleMemoryConsolidation({
    id: "consolidate-inferred",
    customerId: "customer-1",
    now,
  });
  const job = control.claimDueJob("worker-inferred", now)!;
  assert.throws(
    () =>
      control.completeMemoryConsolidation(
        job.id,
        "worker-inferred",
        job.claimFence,
        {
          customerId: "customer-1",
          globalSummary: "偏好黑色",
          promotedIds: ["candidate-inferred"],
          prunedIds: [],
        },
        now,
      ),
    /inferred memory is not verified/,
  );
  assert.equal(
    control.listMemoryCandidates("customer-1")[0].status,
    "candidate",
  );
});

test("expired consolidation cannot commit and no-output preserves the existing summary", () => {
  const { control, memory } = stores();
  memory.upsertCustomer("customer-1", { globalSummary: "保留摘要" });
  control.enqueueJob({
    id: "consolidate-expired",
    type: "memory_consolidate",
    customerId: "customer-1",
    payload: {},
    dueAt: now,
    idempotencyKey: "expired",
  });
  const claim = control.claimDueJob("worker-1", now, 1)!;
  const afterExpiry = "2026-07-11T00:00:00.002Z";
  assert.equal(
    control.completeMemoryConsolidation(
      claim.id,
      "worker-1",
      claim.claimFence,
      {
        customerId: "customer-1",
        globalSummary: "不应写入",
        promotedIds: [],
        prunedIds: [],
      },
      afterExpiry,
    ),
    false,
  );
  const reclaimed = control.claimDueJob("worker-2", afterExpiry)!;
  assert.equal(
    control.completeMemoryConsolidation(
      reclaimed.id,
      "worker-2",
      reclaimed.claimFence,
      {
        customerId: "customer-1",
        globalSummary: "",
        promotedIds: [],
        prunedIds: [],
      },
      afterExpiry,
    ),
    true,
  );
  assert.equal(control.getJob(reclaimed.id)?.status, "succeeded_no_output");
  assert.equal(memory.getCustomer("customer-1")?.globalSummary, "保留摘要");
});

test("invalid consolidation rolls back candidate and summary changes", () => {
  const { control, memory } = stores();
  memory.upsertCustomer("customer-1", { globalSummary: "原摘要" });
  control.insertMemoryCandidate({
    id: "candidate-1",
    customerId: "customer-1",
    conversationId: "conversation-1",
    sourceTraceId: "trace-1",
    category: "preference",
    key: "color",
    value: "black",
    confidence: 0.9,
    sensitivity: "normal",
    status: "candidate",
  });
  control.enqueueJob({
    id: "consolidate-1",
    type: "memory_consolidate",
    customerId: "customer-1",
    payload: {},
    dueAt: now,
    idempotencyKey: "global-consolidation",
  });
  const claim = control.claimDueJob("worker-1", now)!;
  assert.throws(() =>
    control.completeMemoryConsolidation(
      claim.id,
      "worker-1",
      claim.claimFence,
      {
        customerId: "customer-1",
        globalSummary: "坏摘要",
        promotedIds: ["candidate-1"],
        prunedIds: ["candidate-1"],
      },
      now,
    ),
  );
  assert.equal(
    control.listMemoryCandidates("customer-1")[0].status,
    "candidate",
  );
  assert.equal(memory.getCustomer("customer-1")?.globalSummary, "原摘要");
  assert.equal(control.getJob(claim.id)?.status, "running");
});
