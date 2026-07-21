import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedDemoData } from "../src/demo-data.js";
import { NativeRuntime } from "../src/runtime.js";

test("TypeScript demo seed is repeatable and visible through native stores", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-demo-"));
  const databasePath = join(directory, "chatty.sqlite");
  try {
    const first = seedDemoData(databasePath);
    const second = seedDemoData(databasePath);
    assert.deepEqual(first, second);
    assert.deepEqual(first, {
      orders: 24,
      memories: 10,
      support_requests: 5,
    });

    const runtime = new NativeRuntime(databasePath);
    try {
      assert.equal(runtime.commerce.listOrders().length, 24);
      assert.equal(runtime.memory.search("demo-customer", "", 10).length, 10);
      assert.equal(runtime.support.listAll().length, 5);
      assert.deepEqual(runtime.commerce.statusCounts(), {
        pending: 8,
        confirmed: 8,
        cancelled: 8,
      });
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
