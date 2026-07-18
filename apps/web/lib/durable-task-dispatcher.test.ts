import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDurableTaskRepository, openDatabase } from "@rental/db";
import { dispatchDueDurableTask } from "./durable-task-dispatcher";

test("a due follow-up survives restart and is delivered exactly once", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "chatty-followup-")),
    "tasks.sqlite",
  );
  const firstDb = openDatabase(path);
  const firstTasks = createDurableTaskRepository(firstDb);
  const task = firstTasks.create({
    id: "followup-1",
    conversationId: "conversation-1",
    subject: "回访",
    context: { reason: "确认是否需要下单" },
  });
  firstTasks.wait(task.id, "time", { dueAt: "2026-08-01T00:00:00.000Z" });
  firstDb.close();

  const restartedDb = openDatabase(path);
  const tasks = createDurableTaskRepository(restartedDb);
  let deliveries = 0;
  const deliver = async () => {
    deliveries += 1;
    return { receiptId: `delivery-${deliveries}` };
  };
  assert.equal(
    await dispatchDueDurableTask({
      tasks,
      now: "2026-08-01T00:00:01.000Z",
      deliver,
    }),
    true,
  );
  assert.equal(
    await dispatchDueDurableTask({
      tasks,
      now: "2026-08-01T00:00:02.000Z",
      deliver,
    }),
    false,
  );
  assert.equal(deliveries, 1);
  assert.equal(tasks.get(task.id)?.status, "completed");
  restartedDb.close();
});
