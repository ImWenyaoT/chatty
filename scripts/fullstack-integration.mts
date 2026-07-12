import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "@rental/db";

const root = resolve(import.meta.dirname, "..");
const dbPath = join(
  mkdtempSync(join(tmpdir(), "chatty-fullstack-")),
  "chatty.sqlite",
);
const port = 3400 + (process.pid % 1000);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  ["scripts/next-with-root-env.mjs", "start", "-p", String(port)],
  {
    cwd: join(root, "apps/web"),
    env: { ...process.env, CHATTY_DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

async function waitUntilReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // Server startup races are expected until the health endpoint is ready.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Next server did not become ready");
}

try {
  await waitUntilReady();
  const page = await fetch(`${origin}/orders`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /订单跟进/);

  const response = await fetch(`${origin}/api/orders/place`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "fullstack-customer",
      productId: "SUIT-001",
      conversationId: "fullstack-conversation",
      orderNo: "FULLSTACK-001",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((resolveExit) =>
    server.once("exit", () => resolveExit()),
  );
}

const db = openDatabase(dbPath);
const row = db
  .prepare(
    "SELECT conversation_profile_json FROM product_memories WHERE conversation_id = ?",
  )
  .get("fullstack-conversation") as { conversation_profile_json: string };
assert.equal(
  JSON.parse(row.conversation_profile_json).orderPlacement.orderNo,
  "FULLSTACK-001",
);
db.close();
console.log("fullstack integration: PASS (page -> HTTP API -> SQLite)");
