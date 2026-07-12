import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneRepository, openDatabase } from "@rental/db";
import {
  dispatchBackgroundJob,
  type BackgroundJobExecutors,
} from "./background-job-worker";

const dueAt = "2026-07-11T00:00:00.000Z";

/** Builds executors whose unused job types fail the test immediately. */
function executors(
  scheduledFollowup: BackgroundJobExecutors["scheduledFollowup"],
): BackgroundJobExecutors {
  const unexpected = async () => {
    throw new Error("unexpected executor");
  };
  return {
    memoryExtract: unexpected,
    memoryConsolidate: unexpected,
    scheduledFollowup,
  };
}

test("reclaimed claimant fences stale completion and produces one atomic outbox delivery", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.enqueueJob({
    id: "followup-1",
    type: "scheduled_followup",
    conversationId: "conversation-1",
    payload: { reason: "确认尺码" },
    dueAt,
    idempotencyKey: "followup-1",
  });
  const stale = control.claimDueJob("worker-stale", dueAt, 1)!;
  const freshNow = new Date(new Date(dueAt).getTime() + 2).toISOString();
  const fresh = control.claimDueJob("worker-fresh", freshNow)!;

  assert.equal(fresh.claimFence, stale.claimFence + 1);
  assert.equal(
    control.completeFollowup("followup-1", "worker-stale", stale.claimFence, {
      id: "outbox:followup-1",
      conversationId: "conversation-1",
      runId: "stale-run",
      payload: { reply: "stale" },
      idempotencyKey: "outbox:followup-1",
    }),
    false,
  );
  assert.equal(control.listOutbox().length, 0);
  assert.equal(
    control.listJobEvents("followup-1").at(-1)?.type,
    "completion_rejected",
  );
  assert.equal(
    control.completeFollowup("followup-1", "worker-fresh", fresh.claimFence, {
      id: "outbox:followup-1",
      conversationId: "conversation-1",
      runId: "fresh-run",
      payload: { reply: "fresh" },
      idempotencyKey: "outbox:followup-1",
    }),
    true,
  );
  assert.equal(control.getJob("followup-1")?.status, "succeeded");
  assert.equal(control.listOutbox().length, 1);
  assert.equal(control.listOutbox()[0].runId, "fresh-run");
});

test("running cancellation aborts the shared executor signal without retry or delivery", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.enqueueJob({
    id: "cancel-followup",
    type: "scheduled_followup",
    conversationId: "conversation-1",
    payload: {},
    dueAt,
    idempotencyKey: "cancel-followup",
  });
  let observedAbort = false;
  const execution = dispatchBackgroundJob({
    control,
    workerId: "worker-1",
    now: () => new Date(dueAt),
    leaseMs: 1_000,
    heartbeatMs: 5,
    executors: executors(async (_job, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        });
      });
      throw signal.reason;
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(control.cancelJob("cancel-followup"), true);
  await execution;

  assert.equal(observedAbort, true);
  assert.equal(control.getJob("cancel-followup")?.status, "cancelled");
  assert.equal(control.listOutbox().length, 0);
  assert.ok(
    control
      .listJobEvents("cancel-followup")
      .some((event) => event.type === "heartbeat_lost"),
  );
});

test("follow-up executor result, outbox, and completion share a stable idempotency key", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.enqueueJob({
    id: "deliver-once",
    type: "scheduled_followup",
    conversationId: "conversation-1",
    payload: {},
    dueAt,
    idempotencyKey: "deliver-once",
  });
  const processed = await dispatchBackgroundJob({
    control,
    workerId: "worker-1",
    now: () => new Date(dueAt),
    executors: executors(async () => ({
      event: { traceId: "trace-1" },
      followup: { runId: "run-1", payload: { reply: "已确认" } },
    })),
  });

  assert.equal(processed, true);
  assert.equal(control.getJob("deliver-once")?.runId, "run-1");
  assert.deepEqual(
    control.listOutbox().map((message) => message.idempotencyKey),
    ["outbox:deliver-once"],
  );
  assert.deepEqual(
    control.listJobEvents("deliver-once").map((event) => event.type),
    ["scheduled", "claimed", "succeeded"],
  );
});

test("atomic follow-up completion rolls back its outbox insert when completion cannot commit", () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  control.appendOutbox({
    id: "occupied-id",
    conversationId: "other",
    runId: "other-run",
    payload: {},
    idempotencyKey: "other-key",
  });
  control.enqueueJob({
    id: "rollback-followup",
    type: "scheduled_followup",
    conversationId: "conversation-1",
    payload: {},
    dueAt,
    idempotencyKey: "rollback-followup",
  });
  const claim = control.claimDueJob("worker-1", dueAt)!;

  assert.throws(() =>
    control.completeFollowup(
      "rollback-followup",
      "worker-1",
      claim.claimFence,
      {
        id: "occupied-id",
        conversationId: "conversation-1",
        runId: "run-1",
        payload: {},
        idempotencyKey: "outbox:rollback-followup",
      },
    ),
  );
  assert.equal(control.getJob("rollback-followup")?.status, "running");
  assert.equal(control.listOutbox().length, 1);
});
