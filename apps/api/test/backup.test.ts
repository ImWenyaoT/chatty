import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ChattyRunModule } from "../src/agent-runtime.js";
import { backupDatabase } from "../src/backup.js";
import { seedDemoData } from "../src/demo-data.js";
import { EvalModel } from "../src/eval-runner.js";
import { NativeRuntime } from "../src/runtime.js";
import { SQLiteSession } from "../src/session.js";

test("hot SQLite backup restores every persistent runtime contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-backup-"));
  const sourcePath = join(directory, "source.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  seedDemoData(sourcePath);
  const runtime = new NativeRuntime(sourcePath);
  const module = new ChattyRunModule(runtime, {
    model: new EvalModel([
      {
        type: "message",
        message_id: "backup-message",
        text: "备份前的 Agent Run 已完成。",
      },
    ]),
    modelId: "backup-test-model",
    knowledgePath: resolve(
      import.meta.dirname,
      "../../../knowledge/records.jsonl",
    ),
  });
  try {
    const run = await module.run({
      message: "请记录这次备份测试",
      customer_id: "backup-customer",
      request_id: "backup-request",
    });
    assert((await backupDatabase(sourcePath, backupPath)) > 0);

    const restored = new NativeRuntime(backupPath);
    try {
      assert.equal(restored.commerce.listOrders().length, 24);
      assert.equal(
        restored.memory.search("demo-customer", "L 码", 10).length,
        1,
      );
      assert.equal(restored.support.listAll().length, 5);
      assert(restored.knowledge.search("租期", 5).results.length > 0);
      assert.equal(restored.traces.get(run.trace_id)?.status, "completed");
      assert(restored.traces.spanTypes(run.trace_id).includes("agent"));
      assert.equal(
        (
          await new SQLiteSession(
            run.session_id,
            restored.commerce.database,
          ).getItems()
        ).length,
        2,
      );
      const integrity = restored.commerce.database
        .prepare("PRAGMA integrity_check")
        .get() as { integrity_check: string };
      assert.equal(integrity.integrity_check, "ok");
    } finally {
      restored.close();
    }
  } finally {
    await module.close();
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
