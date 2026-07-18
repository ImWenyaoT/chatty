import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneRepository } from "./control-plane-repository.js";
import { openDatabase } from "./database.js";
import { createDurableTaskRepository } from "./durable-task-repository.js";

test("workflow controller enforces one active run and idempotent replay", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const first = control.startRun({
    id: "run-1",
    sessionId: "session-1",
    conversationId: "conversation-1",
    idempotencyKey: "event-1",
  });
  assert.equal(control.startRun({ ...first, id: "ignored" }).id, "run-1");
  assert.throws(
    () =>
      control.startRun({
        id: "run-2",
        sessionId: "session-1",
        conversationId: "conversation-1",
        idempotencyKey: "event-2",
      }),
    /active run/,
  );
  assert.equal(control.transitionRun(first.id, "running").status, "running");
  assert.equal(
    control.transitionRun(first.id, "completed").status,
    "completed",
  );
});

test("workflow lease expires, fences the old owner, and can be renewed by its owner", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.startRun({
    id: "run-lease",
    sessionId: "session-1",
    conversationId: "conversation-lease",
    idempotencyKey: "event-lease",
  });
  const first = control.claimRun(
    "run-lease",
    "worker-old",
    "2026-07-11T00:00:00.000Z",
    1_000,
  );
  assert.equal(first?.leaseOwner, "worker-old");
  assert.equal(
    control.heartbeatRun(
      "run-lease",
      "worker-old",
      "2026-07-11T00:00:00.500Z",
      1_000,
    ),
    true,
  );
  assert.equal(
    control.claimRun("run-lease", "worker-new", "2026-07-11T00:00:01.000Z"),
    undefined,
  );
  const recovered = control.claimRun(
    "run-lease",
    "worker-new",
    "2026-07-11T00:00:02.000Z",
  );
  assert.equal(recovered?.leaseOwner, "worker-new");
  assert.throws(
    () =>
      control.transitionRun("run-lease", "completed", undefined, "worker-old"),
    /lease lost/,
  );
  assert.equal(
    control.transitionRun("run-lease", "completed", undefined, "worker-new")
      .status,
    "completed",
  );
});

test("conversation queue preserves FIFO and deduplicates idempotent input", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const firstId = control.enqueueConversationEvent(
    "conversation-1",
    "event-1",
    { question: "一" },
  );
  assert.equal(
    control.enqueueConversationEvent("conversation-1", "event-1", {
      question: "重复",
    }),
    firstId,
  );
  control.enqueueConversationEvent("conversation-1", "event-2", {
    question: "二",
  });
  assert.deepEqual(control.dequeueConversationEvent("conversation-1"), {
    question: "一",
  });
  assert.deepEqual(control.dequeueConversationEvent("conversation-1"), {
    question: "二",
  });
});

test("startup recovery releases an interrupted FIFO claim", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.enqueueConversationEvent("conversation-restart", "event-restart", {
    question: "恢复",
  });
  const claimed = control.claimConversationEvent("conversation-restart");
  assert.ok(claimed);
  assert.equal(
    control.claimConversationEvent("conversation-restart"),
    undefined,
  );
  assert.equal(control.releaseInterruptedConversationEvents(), 1);
  assert.deepEqual(
    control.claimConversationEvent("conversation-restart")?.event,
    {
      question: "恢复",
    },
  );
});

test("human handoff has a distinct state and explicit leased resume transition", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.startRun({
    id: "run-handoff",
    sessionId: "session-1",
    conversationId: "conversation-handoff",
    idempotencyKey: "event-handoff",
  });
  control.claimRun("run-handoff", "worker-old", "2026-07-11T00:00:00.000Z");
  assert.equal(
    control.transitionRun(
      "run-handoff",
      "waiting_for_handoff",
      undefined,
      "worker-old",
    ).status,
    "waiting_for_handoff",
  );
  const resumed = control.resumeHandoff(
    "run-handoff",
    "worker-human-resume",
    "2026-07-11T00:01:00.000Z",
  );
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.leaseOwner, "worker-human-resume");
});

test("background jobs use leases, retries, cancellation, and idempotency", () => {
  const db = openDatabase(":memory:");
  const control = createControlPlaneRepository(db);
  const tasks = createDurableTaskRepository(db);
  const task = tasks.create({
    id: "task-1",
    conversationId: "conversation-1",
    subject: "确认尺码",
  });
  tasks.wait(task.id, "time", { dueAt: "2026-07-11T00:00:00.000Z" });
  const dueAt = "2026-07-11T00:00:00.000Z";
  const job = control.enqueueJob({
    id: "job-1",
    type: "scheduled_followup",
    conversationId: "conversation-1",
    payload: { reason: "确认尺码", durableTaskId: task.id },
    dueAt,
    idempotencyKey: "followup-1",
  });
  assert.equal(
    control.enqueueJob({
      id: "ignored",
      type: job.type,
      conversationId: job.conversationId,
      payload: job.payload,
      dueAt: job.dueAt,
      idempotencyKey: "followup-1",
    }).id,
    "job-1",
  );
  const claimed = control.claimDueJob("worker-1", dueAt);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.attempts, 1);
  control.failJob("job-1", "temporary", "2026-07-11T00:01:00.000Z");
  assert.equal(control.getJob("job-1")?.status, "pending");
  assert.equal(control.cancelJob("job-1"), true);
  assert.equal(tasks.get(task.id)?.status, "cancelled");
});

test("retryJob resets attempts so a terminally-failed job is claimable again", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const dueAt = "2026-07-11T00:00:00.000Z";
  control.enqueueJob({
    id: "job-retry",
    type: "scheduled_followup",
    conversationId: "conversation-retry",
    payload: { reason: "确认尺码" },
    dueAt,
    idempotencyKey: "retry-1",
    maxAttempts: 1,
  });
  // Claim once (attempts→1) then fail at the cap → terminal 'failed'.
  control.claimDueJob("worker-1", dueAt);
  control.failJob("job-retry", "boom");
  assert.equal(control.getJob("job-retry")?.status, "failed");
  assert.equal(control.getJob("job-retry")?.attempts, 1);

  // Retry must reset attempts, otherwise claimDueJob's `attempts < max_attempts`
  // never matches and the requeued job stays silently stuck.
  assert.equal(control.retryJob("job-retry", dueAt), true);
  assert.equal(control.getJob("job-retry")?.status, "pending");
  assert.equal(control.getJob("job-retry")?.attempts, 0);
  assert.equal(
    control.claimDueJob("worker-2", dueAt)?.id,
    "job-retry",
    "retried job must be claimable by the worker again",
  );
});

test("checkpoint and memory usage preserve durable context evidence", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const checkpoint = control.saveCheckpoint({
    id: "checkpoint-1",
    conversationId: "conversation-1",
    throughTraceId: "trace-1",
    summary: { goal: "确认档期" },
    tokenBefore: 30_000,
    tokenAfter: 2_000,
    model: "deepseek-v4-pro",
  });
  assert.equal(checkpoint.version, 1);
  const memory = control.insertMemoryCandidate({
    id: "memory-1",
    customerId: "customer-1",
    conversationId: "conversation-1",
    sourceTraceId: "trace-1",
    category: "preference",
    key: "preferred_color",
    value: "黑色",
    confidence: 0.95,
    sensitivity: "normal",
    status: "promoted",
  });
  control.markMemoryUsed([memory.id]);
  assert.equal(control.listMemoryCandidates("customer-1")[0].usageCount, 1);
});

test("run reads: getRun, idempotency lookup, status counts, and recoverable list", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  assert.equal(control.getRun("missing"), undefined);
  control.startRun({
    id: "run-r",
    sessionId: "s-1",
    conversationId: "c-r",
    idempotencyKey: "idem-r",
  });
  assert.equal(control.getRun("run-r")?.id, "run-r");
  assert.equal(control.getRunByIdempotencyKey("idem-r")?.id, "run-r");
  assert.equal(control.getRunByIdempotencyKey("nope"), undefined);
  assert.equal(control.countRunsByStatus("queued"), 1);
  assert.equal(control.countRunsByStatus("running"), 0);
  // 排队中的 run 天然可恢复。
  assert.deepEqual(
    control.listRecoverableRuns("2999-01-01T00:00:00.000Z").map((r) => r.id),
    ["run-r"],
  );
  control.transitionRun("run-r", "running");
  assert.equal(control.countRunsByStatus("queued"), 0);
  assert.equal(control.countRunsByStatus("running"), 1);
});

test("run event log sequences per run and counts by type", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.startRun({
    id: "run-e",
    sessionId: "s-1",
    conversationId: "c-e",
    idempotencyKey: "idem-e",
  });
  const first = control.appendRunEvent("run-e", "state_changed", {
    status: "running",
  });
  const second = control.appendRunEvent("run-e", "heartbeat");
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  const events = control.listRunEvents("run-e");
  assert.deepEqual(
    events.map((e) => e.type),
    ["state_changed", "heartbeat"],
  );
  assert.deepEqual(events[0].payload, { status: "running" });
  assert.equal(control.countRunEventsByType("heartbeat"), 1);
  assert.equal(control.listRunEvents("other-run").length, 0);
});

test("saveRunResult persists only for the current running lease owner", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.startRun({
    id: "run-s",
    sessionId: "s-1",
    conversationId: "c-s",
    idempotencyKey: "idem-s",
  });
  // 未 claim（仍 queued）时不可保存结果。
  assert.equal(control.saveRunResult("run-s", "worker", { ok: true }), false);
  control.claimRun("run-s", "worker", "2026-07-11T00:00:00.000Z");
  // 非持锁 owner 不可保存。
  assert.equal(control.saveRunResult("run-s", "intruder", { ok: true }), false);
  assert.equal(control.saveRunResult("run-s", "worker", { ok: true }), true);
});

test("requestRunCancellation fences the run and is idempotent", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.startRun({
    id: "run-c",
    sessionId: "s-1",
    conversationId: "c-c",
    idempotencyKey: "idem-c",
  });
  const cancelled = control.requestRunCancellation("run-c", "user_abort");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(control.countRunEventsByType("cancel_requested"), 1);
  // 幂等：二次取消不再追加事件。
  control.requestRunCancellation("run-c", "user_abort");
  assert.equal(control.countRunEventsByType("cancel_requested"), 1);
  assert.throws(() => control.requestRunCancellation("missing"), /not found/);
});
