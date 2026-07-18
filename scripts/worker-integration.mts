import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlPlaneRepository,
  createDurableTaskRepository,
  openDatabase,
} from "../packages/db/src/index.ts";

const directory = mkdtempSync(join(tmpdir(), "chatty-worker-integration-"));
const databasePath = join(directory, "worker.db");

try {
  const seedDb = openDatabase(databasePath);
  const seedControl = createControlPlaneRepository(seedDb);
  const seedTasks = createDurableTaskRepository(seedDb);
  const task = seedTasks.create({
    id: "integration-task",
    conversationId: "conversation-integration",
    subject: "scheduled integration follow-up",
  });
  seedTasks.wait(task.id, "time", { dueAt: "2020-01-01T00:00:00.000Z" });
  seedControl.enqueueJob({
    id: "integration-followup",
    type: "scheduled_followup",
    customerId: "customer-integration",
    conversationId: "conversation-integration",
    payload: { reason: "integration fixture", durableTaskId: task.id },
    dueAt: "2020-01-01T00:00:00.000Z",
    idempotencyKey: "integration-followup",
  });
  seedDb.close();

  // Invoke the worker runtime directly: an integration test must exercise the
  // worker, not the package manager that happens to launch it.
  const worker = spawnSync(
    process.execPath,
    [
      "--env-file-if-exists=.env",
      "--import",
      "tsx",
      "scripts/worker.mts",
      "--once",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CHATTY_DB_PATH: databasePath,
        CHATTY_WORKER_ID: "integration-worker",
        CHATTY_WORKER_FIXTURE: "scheduled-followup",
        DEEPSEEK_API_KEY: "",
        OPENAI_API_KEY: "",
      },
    },
  );
  assert.equal(
    worker.status,
    0,
    `worker failed:\n${worker.stdout}\n${worker.stderr}`,
  );

  const verifyDb = openDatabase(databasePath);
  const verifyControl = createControlPlaneRepository(verifyDb);
  const verifyTasks = createDurableTaskRepository(verifyDb);
  const job = verifyControl.getJob("integration-followup");
  const outbox = verifyControl.listOutbox();
  assert.equal(
    job?.status,
    "succeeded",
    "one-shot worker did not complete the seeded job",
  );
  assert.equal(
    job?.attempts,
    1,
    "one-shot worker must claim the seeded job exactly once",
  );
  assert.equal(
    outbox.length,
    1,
    "one-shot worker must publish exactly one delivery",
  );
  assert.equal(outbox[0].id, "outbox:integration-followup");
  assert.equal(verifyTasks.get(task.id)?.status, "completed");
  assert.equal(
    outbox[0].runId,
    job?.runId,
    "job completion and outbox must commit one run",
  );
  assert.equal(
    (outbox[0].payload as Record<string, unknown>).sourceJobId,
    "integration-followup",
  );
  assert.deepEqual(
    verifyControl
      .listJobEvents("integration-followup")
      .map((event) => event.type),
    ["scheduled", "claimed", "succeeded"],
  );
  verifyDb.close();
  console.log(
    "worker integration: PASS (seeded job claimed, completed, and delivered once)",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
