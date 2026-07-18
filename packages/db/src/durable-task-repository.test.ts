import assert from "node:assert/strict";
import { test } from "node:test";
import { createDurableTaskRepository, openDatabase } from "./index.js";

test("Durable Task prerequisites block work until their evidence-backed completion", () => {
  const tasks = createDurableTaskRepository(openDatabase(":memory:"));
  tasks.create({
    id: "dependency",
    conversationId: "conversation-1",
    subject: "先决任务",
  });
  tasks.create({
    id: "dependent",
    conversationId: "conversation-1",
    subject: "后续任务",
    blockedBy: ["dependency"],
  });

  assert.throws(() => tasks.claim("dependent"), /blocked/);
  tasks.claim("dependency");
  assert.throws(
    () =>
      tasks.complete("dependency", {
        kind: "tool_receipt",
        toolName: "",
        receiptId: "",
      }),
    /verified evidence/,
  );
  tasks.complete("dependency", {
    kind: "tool_receipt",
    toolName: "check_availability",
    receiptId: "trace-1:0",
  });
  assert.equal(tasks.claim("dependent").status, "in_progress");
});

test("waiting tasks survive SQLite reopen and can be cancelled idempotently", () => {
  const db = openDatabase(":memory:");
  const tasks = createDurableTaskRepository(db);
  const task = tasks.create({
    id: "followup",
    conversationId: "conversation-1",
    subject: "到时回访",
  });
  tasks.wait(task.id, "time", { dueAt: "2026-08-01T00:00:00.000Z" });
  assert.equal(tasks.cancel(task.id).status, "cancelled");
  assert.equal(tasks.cancel(task.id).status, "cancelled");
});
