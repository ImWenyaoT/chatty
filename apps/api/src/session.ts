import type { AgentInputItem, Session } from "@openai/agents";
import { DatabaseSync } from "node:sqlite";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function storedItem(item: AgentInputItem): JsonObject {
  const value = structuredClone(item) as JsonObject;
  if (value.type === "function_call") {
    const rest = { ...value };
    const callId = rest.callId;
    delete rest.callId;
    delete rest.providerData;
    return { ...rest, call_id: callId };
  }
  if (value.type === "function_call_result") {
    const rest = { ...value };
    const callId = rest.callId;
    const output = rest.output;
    delete rest.callId;
    delete rest.providerData;
    delete rest.name;
    delete rest.status;
    return { ...rest, type: "function_call_output", call_id: callId, output };
  }
  delete value.providerData;
  return value;
}

function sdkItems(items: JsonObject[]): AgentInputItem[] {
  const toolNames = new Map<string, string>();
  const converted: JsonObject[] = [];
  for (const item of items) {
    if (item.type === "function_call") {
      const callId = item.callId ?? item.call_id;
      if (typeof callId === "string" && typeof item.name === "string") {
        toolNames.set(callId, item.name);
      }
      const rest = { ...item };
      delete rest.call_id;
      converted.push({ ...rest, callId });
      continue;
    }
    if (item.type === "function_call_output") {
      const callId = item.callId ?? item.call_id;
      const name =
        typeof callId === "string" ? toolNames.get(callId) : undefined;
      const rest = { ...item };
      delete rest.call_id;
      converted.push({
        ...rest,
        type: "function_call_result",
        callId,
        name: name ?? "unknown_tool",
        status: "completed",
      });
      continue;
    }
    converted.push(item);
  }
  return converted as AgentInputItem[];
}

export class SQLiteSession implements Session {
  constructor(
    private readonly sessionId: string,
    private readonly database: DatabaseSync,
  ) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chatty_sessions (
          session_id TEXT PRIMARY KEY,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS chatty_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          message_data TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES chatty_sessions (session_id)
              ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chatty_messages_session_id
          ON chatty_messages (session_id, id);
    `);
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = this.getStoredItems();
    return sdkItems(limit === undefined ? items : items.slice(-limit));
  }

  getStoredItems(): JsonObject[] {
    const rows = this.database
      .prepare(
        `SELECT message_data FROM chatty_messages
         WHERE session_id = ? ORDER BY id ASC`,
      )
      .all(this.sessionId) as Array<{ message_data: string }>;
    const items: JsonObject[] = [];
    for (const row of rows) {
      try {
        const parsed = object(JSON.parse(row.message_data) as unknown);
        if (parsed !== null) items.push(parsed);
      } catch {
        // Match the Python session: corrupted rows are skipped.
      }
    }
    return items;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "INSERT OR IGNORE INTO chatty_sessions (session_id) VALUES (?)",
        )
        .run(this.sessionId);
      const insert = this.database.prepare(
        "INSERT INTO chatty_messages (session_id, message_data) VALUES (?, ?)",
      );
      for (const item of items) {
        insert.run(this.sessionId, JSON.stringify(storedItem(item)));
      }
      this.database
        .prepare(
          `UPDATE chatty_sessions SET updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`,
        )
        .run(this.sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    while (true) {
      const row = this.database
        .prepare(
          `DELETE FROM chatty_messages
           WHERE id = (
             SELECT id FROM chatty_messages WHERE session_id = ?
             ORDER BY id DESC LIMIT 1
           ) RETURNING message_data`,
        )
        .get(this.sessionId) as { message_data: string } | undefined;
      if (row === undefined) return undefined;
      try {
        return sdkItems([JSON.parse(row.message_data) as JsonObject])[0];
      } catch {
        // Drop the corrupted row and continue like the Python implementation.
      }
    }
  }

  async clearSession(): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("DELETE FROM chatty_messages WHERE session_id = ?")
        .run(this.sessionId);
      this.database
        .prepare("DELETE FROM chatty_sessions WHERE session_id = ?")
        .run(this.sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
