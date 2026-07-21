import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AgentInputItem } from "@openai/agents";
import { SQLiteSession } from "../src/session.js";

test("TypeScript Session reads and writes legacy Python canonical rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-session-"));
  const databasePath = join(directory, "chatty.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    const session = new SQLiteSession("session-1", database);
    database
      .prepare("INSERT OR IGNORE INTO chatty_sessions (session_id) VALUES (?)")
      .run("session-1");
    const insert = database.prepare(
      "INSERT INTO chatty_messages (session_id, message_data) VALUES (?, ?)",
    );
    insert.run(
      "session-1",
      JSON.stringify({
        type: "function_call",
        name: "view_order",
        call_id: "call-1",
        arguments: '{"order_id":"order-1"}',
      }),
    );
    insert.run(
      "session-1",
      JSON.stringify({
        type: "function_call_output",
        call_id: "call-1",
        output: '{"ok":true}',
      }),
    );

    assert.deepEqual(await session.getItems(), [
      {
        type: "function_call",
        name: "view_order",
        callId: "call-1",
        arguments: '{"order_id":"order-1"}',
      },
      {
        type: "function_call_result",
        name: "view_order",
        callId: "call-1",
        status: "completed",
        output: '{"ok":true}',
      },
    ]);

    await session.clearSession();
    await session.addItems([
      { role: "user", content: "查看订单" },
      {
        type: "function_call",
        name: "view_order",
        callId: "call-2",
        arguments: '{"order_id":"order-2"}',
      },
      {
        type: "function_call_result",
        name: "view_order",
        callId: "call-2",
        status: "completed",
        output: '{"ok":false,"error":"order_not_found"}',
      },
    ] satisfies AgentInputItem[]);

    const stored = database
      .prepare(
        "SELECT message_data FROM chatty_messages WHERE session_id = ? ORDER BY id",
      )
      .all("session-1") as Array<{ message_data: string }>;
    assert.deepEqual(
      stored.map((row) => JSON.parse(row.message_data)),
      [
        { role: "user", content: "查看订单" },
        {
          type: "function_call",
          name: "view_order",
          call_id: "call-2",
          arguments: '{"order_id":"order-2"}',
        },
        {
          type: "function_call_output",
          call_id: "call-2",
          output: '{"ok":false,"error":"order_not_found"}',
        },
      ],
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
