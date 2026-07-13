import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneRepository, openDatabase } from "@rental/db";
import {
  buildConversationControlView,
  buildOperationsControlView,
} from "./control-plane-read-model";

test("conversation control view explains queue depth and an expired workflow as recovering", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.startRun({
    id: "run-1",
    sessionId: "session-1",
    conversationId: "conversation-1",
    idempotencyKey: "request-1",
  });
  control.claimRun("run-1", "worker-1", "2026-07-11T00:00:00.000Z", 1_000);
  control.enqueueConversationEvent("conversation-1", "queued-1", {
    question: "下一条",
  });

  const view = buildConversationControlView(control, {
    conversationId: "conversation-1",
    runId: "run-1",
    now: "2026-07-11T00:00:02.000Z",
  });

  assert.equal(view.queueDepth, 1);
  assert.equal(view.workflow.displayState, "recovering");
  assert.equal(view.workflow.leaseOwner, "worker-1");
  assert.equal(view.workflow.leaseExpired, true);
});

test("conversation control view reports unknown instead of success without a run", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const view = buildConversationControlView(control, {
    conversationId: "missing",
    runId: "missing",
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(view.queueDepth, 0);
  assert.deepEqual(view.workflow, {
    displayState: "unknown",
    leaseExpired: false,
  });
});

test("conversation control view reports queued when durable input awaits a run", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.enqueueConversationEvent("conversation-queued", "request-queued", {
    question: "等待",
  });

  const view = buildConversationControlView(control, {
    conversationId: "conversation-queued",
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(view.workflow.displayState, "queued");
});

test("operations control view exposes job evidence, delivery and aggregate health", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.startRun({
    id: "failed-run",
    sessionId: "session-1",
    conversationId: "conversation-1",
    idempotencyKey: "failed-request",
  });
  control.transitionRun("failed-run", "running");
  control.transitionRun("failed-run", "failed", "provider_error");
  control.appendRunEvent("failed-run", "compacted");
  control.appendRunEvent("failed-run", "compaction_failed");
  control.enqueueJob({
    id: "job-1",
    type: "scheduled_followup",
    conversationId: "conversation-1",
    payload: {},
    dueAt: "2026-07-11T00:00:00.000Z",
    maxAttempts: 3,
    idempotencyKey: "job-request-1",
  });
  const claimed = control.claimDueJob(
    "worker-1",
    "2026-07-11T00:00:00.000Z",
    60_000,
  )!;
  control.failJob(
    "job-1",
    "temporary",
    "2026-07-11T00:01:00.000Z",
    "worker-1",
    claimed.claimFence,
  );
  const reclaimed = control.claimDueJob(
    "worker-2",
    "2026-07-11T00:01:00.000Z",
    60_000,
  )!;
  control.completeFollowup("job-1", "worker-2", reclaimed.claimFence, {
    id: "outbox-1",
    conversationId: "conversation-1",
    runId: "followup-run",
    payload: {},
    idempotencyKey: "delivery-1",
  });
  control.enqueueJob({
    id: "memory-1",
    type: "memory_extract",
    conversationId: "conversation-1",
    payload: {},
    dueAt: "2026-07-11T00:02:00.000Z",
    maxAttempts: 1,
    idempotencyKey: "memory-request-1",
  });
  const memory = control.claimDueJob("worker-3", "2026-07-11T00:02:00.000Z")!;
  control.finishJob(
    "memory-1",
    "succeeded_no_output",
    {},
    "worker-3",
    memory.claimFence,
  );

  const view = buildOperationsControlView(control, "2026-07-11T00:03:00.000Z");

  assert.equal(
    view.jobs
      .find((job) => job.id === "job-1")
      ?.events.some((event) => event.type === "retry_scheduled"),
    true,
  );
  assert.equal(view.outbox[0].status, "pending");
  assert.deepEqual(view.metrics, {
    workflowFailures: 1,
    compactions: 1,
    compactionFailures: 1,
    memoryNoOps: 1,
    retryRate: 0.5,
    followupLatencyMs: view.metrics.followupLatencyMs,
  });
  assert.equal(typeof view.metrics.followupLatencyMs, "number");
});

test("aggregate health includes jobs beyond the operations display limit", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  for (let index = 0; index < 101; index += 1) {
    control.enqueueJob({
      id: `memory-${index}`,
      type: "memory_extract",
      payload: {},
      dueAt: "2026-07-11T00:00:00.000Z",
      maxAttempts: 1,
      idempotencyKey: `memory-${index}`,
    });
    const job = control.claimDueJob("worker", "2026-07-11T00:00:00.000Z")!;
    control.finishJob(
      job.id,
      "succeeded_no_output",
      {},
      "worker",
      job.claimFence,
    );
  }

  const view = buildOperationsControlView(control);
  assert.equal(view.jobs.length, 100);
  assert.equal(view.metrics.memoryNoOps, 101);
});
