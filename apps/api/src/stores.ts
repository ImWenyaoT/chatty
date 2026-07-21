import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CustomerMemorySchema,
  SupportRequestSchema,
  TraceSpanSchema,
  type CustomerMemory,
  type SupportRequest,
  type Trace,
  type TraceSpan,
} from "@chatty/contracts";
import {
  integer,
  nullableText,
  type SqliteRow as Row,
  text,
} from "./sqlite-row.js";
import { unicodeCaseFold } from "./unicode.js";

export type TraceSummary = Omit<Trace, "span_types" | "spans">;

function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function stringArray(row: Row, key: string): string[] {
  const value = JSON.parse(text(row, key)) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid SQLite string array: ${key}`);
  }
  return value;
}

export class SessionCustomerMismatchError extends Error {}
export class SessionNotFoundError extends Error {}
export class SupportRequestIdempotencyConflictError extends Error {}

const memoryStopCharacters = new Set(
  Array.from("的了和与是我你他她它们什么一下信息客户关于相关"),
);

function memoryQueryCharacters(query: string): string[] {
  const characters: string[] = [];
  for (const character of unicodeCaseFold(query)) {
    if (
      !/[\p{L}\p{N}]/u.test(character) ||
      memoryStopCharacters.has(character)
    ) {
      continue;
    }
    if (!characters.includes(character)) characters.push(character);
  }
  return characters.slice(0, 32);
}

function memoryRelevance(
  fact: string,
  query: string,
  characters: string[],
): number {
  const normalizedFact = unicodeCaseFold(fact);
  const terms = unicodeCaseFold(query)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
  const exactTermScore = terms.reduce(
    (score, term) =>
      score + (normalizedFact.includes(term) ? term.length * 3 : 0),
    0,
  );
  return (
    exactTermScore +
    characters.reduce(
      (score, character) => score + Number(normalizedFact.includes(character)),
      0,
    )
  );
}

export class MemoryStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = openDatabase(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS customer_memories (
          memory_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          fact TEXT NOT NULL,
          source_id TEXT NOT NULL,
          created_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS customer_sessions (
          session_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS customer_memories_customer_created
          ON customer_memories (customer_id, created_at DESC);
    `);
  }

  close(): void {
    this.database.close();
  }

  bindSession(sessionId: string, customerId: string): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO customer_sessions (session_id, customer_id)
         VALUES (?, ?)`,
      )
      .run(sessionId, customerId);
    const row = this.database
      .prepare("SELECT customer_id FROM customer_sessions WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    if (row === undefined || text(row, "customer_id") !== customerId) {
      throw new SessionCustomerMismatchError(
        "session belongs to another customer",
      );
    }
  }

  requireSession(sessionId: string, customerId: string): void {
    const row = this.database
      .prepare("SELECT customer_id FROM customer_sessions WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    if (row === undefined) {
      throw new SessionNotFoundError("session was not issued by this Harness");
    }
    if (text(row, "customer_id") !== customerId) {
      throw new SessionCustomerMismatchError(
        "session belongs to another customer",
      );
    }
  }

  save(customerId: string, fact: string, sourceId: string): CustomerMemory {
    const memoryId = `memory_${randomUUID().replaceAll("-", "")}`;
    this.database
      .prepare(
        `INSERT INTO customer_memories (memory_id, customer_id, fact, source_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(memoryId, customerId, fact, sourceId);
    const row = this.database
      .prepare(
        `SELECT memory_id, customer_id, fact, source_id, created_at
         FROM customer_memories WHERE memory_id = ?`,
      )
      .get(memoryId) as Row | undefined;
    if (row === undefined) throw new Error("saved memory could not be read");
    return this.memory(row);
  }

  search(customerId: string, query: string, limit: number): CustomerMemory[] {
    const escapedQuery = query
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    let rows = this.database
      .prepare(
        `SELECT memory_id, customer_id, fact, source_id, created_at
         FROM customer_memories
         WHERE customer_id = ? AND fact LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC, memory_id DESC
         LIMIT ?`,
      )
      .all(customerId, `%${escapedQuery}%`, limit) as Row[];
    if (rows.length === 0 && query.trim()) {
      const characters = memoryQueryCharacters(query);
      if (characters.length > 0) {
        const predicates = characters.map(() => "fact LIKE ?").join(" OR ");
        rows = this.database
          .prepare(
            `SELECT memory_id, customer_id, fact, source_id, created_at
             FROM customer_memories
             WHERE customer_id = ? AND (${predicates})
             ORDER BY created_at DESC, memory_id DESC
             LIMIT ?`,
          )
          .all(
            customerId,
            ...characters.map((character) => `%${character}%`),
            Math.min(100, Math.max(20, limit * 10)),
          ) as Row[];
        rows.sort(
          (left, right) =>
            memoryRelevance(text(right, "fact"), query, characters) -
            memoryRelevance(text(left, "fact"), query, characters),
        );
        rows = rows.slice(0, limit);
      }
    }
    return rows.map((row) => this.memory(row));
  }

  private memory(row: Row): CustomerMemory {
    return CustomerMemorySchema.parse({
      memory_id: text(row, "memory_id"),
      customer_id: text(row, "customer_id"),
      fact: text(row, "fact"),
      source_id: text(row, "source_id"),
      created_at: text(row, "created_at"),
    });
  }
}

export class SupportRequestStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = openDatabase(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS support_requests (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          customer_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          context TEXT NOT NULL,
          model_context TEXT NOT NULL,
          prior_actions TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  create(input: {
    customer_id: string;
    session_id: string;
    reason: string;
    context: string;
    model_context: string;
    prior_actions: string[];
    idempotency_key: string;
  }): SupportRequest {
    const reason = input.reason.trim();
    const context = input.context.trim();
    const modelContext = input.model_context.trim();
    if (!reason || !context) {
      throw new Error("support reason and context are required");
    }
    const requestId = `support_${randomUUID().replaceAll("-", "")}`;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO support_requests
           (id, idempotency_key, customer_id, session_id, reason, context,
            model_context, prior_actions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(
        requestId,
        input.idempotency_key,
        input.customer_id,
        input.session_id,
        reason,
        context,
        modelContext,
        JSON.stringify(input.prior_actions),
      );
    const row = this.database
      .prepare("SELECT * FROM support_requests WHERE idempotency_key = ?")
      .get(input.idempotency_key) as Row | undefined;
    if (row === undefined) throw new Error("support request was not persisted");
    const request = this.request(row);
    if (
      request.customer_id !== input.customer_id ||
      request.session_id !== input.session_id ||
      request.reason !== reason ||
      request.context !== context ||
      request.model_context !== modelContext ||
      JSON.stringify(request.prior_actions) !==
        JSON.stringify(input.prior_actions)
    ) {
      throw new SupportRequestIdempotencyConflictError(
        "handoff idempotency key was reused with different evidence",
      );
    }
    return request;
  }

  get(requestId: string): SupportRequest | null {
    const row = this.database
      .prepare("SELECT * FROM support_requests WHERE id = ?")
      .get(requestId) as Row | undefined;
    return row === undefined ? null : this.request(row);
  }

  listAll(): SupportRequest[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM support_requests ORDER BY created_at DESC, id DESC",
      )
      .all() as Row[];
    return rows.map((row) => this.request(row));
  }

  private request(row: Row): SupportRequest {
    return SupportRequestSchema.parse({
      id: text(row, "id"),
      customer_id: text(row, "customer_id"),
      session_id: text(row, "session_id"),
      reason: text(row, "reason"),
      context: text(row, "context"),
      model_context: text(row, "model_context"),
      prior_actions: stringArray(row, "prior_actions"),
      status: text(row, "status"),
      created_at: text(row, "created_at"),
      updated_at: text(row, "updated_at"),
    });
  }
}

const traceProjection = `
  trace_id, session_id, status, summary, model_id,
  created_at, updated_at,
  MAX(0, CAST((julianday(updated_at) - julianday(created_at))
      * 86400000 AS INTEGER)) AS duration_ms,
  business_outcome, completion_evidence, knowledge_sources,
  memory_sources, support_request_id
`;

export class TraceStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = openDatabase(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_traces (
          trace_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          model_id TEXT NOT NULL,
          business_outcome TEXT,
          completion_evidence TEXT,
          knowledge_sources TEXT NOT NULL DEFAULT '[]',
          memory_sources TEXT NOT NULL DEFAULT '[]',
          support_request_id TEXT,
          created_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS local_spans (
          span_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          parent_id TEXT,
          span_type TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    this.addMissingColumns();
  }

  close(): void {
    this.database.close();
  }

  start(traceId: string, sessionId: string, modelId: string): void {
    this.database
      .prepare(
        `INSERT INTO local_traces (trace_id, session_id, status, summary, model_id)
         VALUES (?, ?, 'running', 'Agent run started', ?)`,
      )
      .run(traceId, sessionId, modelId);
  }

  complete(traceId: string): void {
    this.finish(traceId, "completed", "Agent run completed");
  }

  fail(traceId: string): void {
    this.finish(traceId, "failed", "Agent run failed");
  }

  get(traceId: string): TraceSummary | null {
    const row = this.database
      .prepare(`SELECT ${traceProjection} FROM local_traces WHERE trace_id = ?`)
      .get(traceId) as Row | undefined;
    return row === undefined ? null : this.trace(row);
  }

  listRecent(limit = 50): TraceSummary[] {
    const rows = this.database
      .prepare(
        `SELECT ${traceProjection}
         FROM local_traces
         ORDER BY created_at DESC, trace_id DESC
         LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => this.trace(row));
  }

  recordOutcome(
    traceId: string,
    outcome: {
      business_outcome: string;
      completion_evidence: string | null;
      knowledge_sources: string[];
      memory_sources: string[];
      support_request_id: string | null;
    },
  ): void {
    this.database
      .prepare(
        `UPDATE local_traces
         SET business_outcome = ?, completion_evidence = ?, knowledge_sources = ?,
             memory_sources = ?, support_request_id = ?
         WHERE trace_id = ?`,
      )
      .run(
        outcome.business_outcome,
        outcome.completion_evidence,
        JSON.stringify([...new Set(outcome.knowledge_sources)].sort()),
        JSON.stringify([...new Set(outcome.memory_sources)].sort()),
        outcome.support_request_id,
        traceId,
      );
  }

  recordSpan(input: {
    span_id: string;
    trace_id: string;
    parent_id: string | null;
    span_type: string;
    failed: boolean;
    name?: string | null;
    started_at?: string | null;
    ended_at?: string | null;
  }): void {
    const status = input.failed ? "failed" : "completed";
    const summary = input.name
      ? `${input.span_type} ${input.name} ${status}`
      : `${input.span_type} span ${status}`;
    this.database
      .prepare(
        `INSERT OR REPLACE INTO local_spans
           (span_id, trace_id, parent_id, span_type, status, summary,
            started_at, ended_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.span_id,
        input.trace_id,
        input.parent_id,
        input.span_type,
        status,
        summary,
        input.started_at ?? null,
        input.ended_at ?? null,
        input.failed ? "sdk_span_error" : null,
      );
  }

  recordToolEvent(traceId: string, status: string, summary: string): void {
    if (status !== "completed" && status !== "failed") {
      throw new Error("invalid tool event status");
    }
    this.database
      .prepare(
        `INSERT INTO local_spans
           (span_id, trace_id, parent_id, span_type, status, summary)
         VALUES (?, ?, NULL, 'tool', ?, ?)`,
      )
      .run(
        `span_${randomUUID().replaceAll("-", "")}`,
        traceId,
        status,
        summary,
      );
  }

  recordError(traceId: string, code: string): void {
    this.database
      .prepare(
        `INSERT INTO local_spans
           (span_id, trace_id, parent_id, span_type, status, summary,
            started_at, ended_at, error)
         VALUES (?, ?, NULL, 'error', 'failed', ?,
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`,
      )
      .run(`span_${randomUUID().replaceAll("-", "")}`, traceId, code, code);
  }

  spans(traceId: string): TraceSpan[] {
    const rows = this.database
      .prepare(
        `SELECT span_id, trace_id, parent_id, span_type, status, summary,
                started_at, ended_at,
                CASE
                    WHEN started_at IS NULL OR ended_at IS NULL THEN NULL
                    ELSE MAX(0, CAST((julianday(ended_at) - julianday(started_at))
                        * 86400000 AS INTEGER))
                END AS duration_ms,
                error
         FROM local_spans
         WHERE trace_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(traceId) as Row[];
    return rows.map((row) =>
      TraceSpanSchema.parse({
        span_id: text(row, "span_id"),
        trace_id: text(row, "trace_id"),
        parent_id: nullableText(row, "parent_id"),
        span_type: text(row, "span_type"),
        status: text(row, "status"),
        summary: text(row, "summary"),
        started_at: nullableText(row, "started_at"),
        ended_at: nullableText(row, "ended_at"),
        duration_ms:
          row.duration_ms === null ? null : integer(row, "duration_ms"),
        error: nullableText(row, "error"),
      }),
    );
  }

  spanTypes(traceId: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT span_type FROM local_spans
         WHERE trace_id = ? ORDER BY span_type`,
      )
      .all(traceId) as Row[];
    return rows.map((row) => text(row, "span_type"));
  }

  private finish(traceId: string, status: string, summary: string): void {
    this.database
      .prepare(
        `UPDATE local_traces
         SET status = ?, summary = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE trace_id = ?`,
      )
      .run(status, summary, traceId);
  }

  private trace(row: Row): TraceSummary {
    return {
      trace_id: text(row, "trace_id"),
      session_id: text(row, "session_id"),
      status: text(row, "status"),
      summary: text(row, "summary"),
      model_id: text(row, "model_id"),
      created_at: text(row, "created_at"),
      updated_at: text(row, "updated_at"),
      duration_ms: integer(row, "duration_ms"),
      business_outcome: nullableText(row, "business_outcome"),
      completion_evidence: nullableText(row, "completion_evidence"),
      knowledge_sources: stringArray(row, "knowledge_sources"),
      memory_sources: stringArray(row, "memory_sources"),
      support_request_id: nullableText(row, "support_request_id"),
    };
  }

  private addMissingColumns(): void {
    const traceColumns = new Set(
      (
        this.database.prepare("PRAGMA table_info(local_traces)").all() as Row[]
      ).map((row) => text(row, "name")),
    );
    for (const [name, declaration] of [
      ["business_outcome", "TEXT"],
      ["completion_evidence", "TEXT"],
      ["knowledge_sources", "TEXT NOT NULL DEFAULT '[]'"],
      ["memory_sources", "TEXT NOT NULL DEFAULT '[]'"],
      ["support_request_id", "TEXT"],
    ] as const) {
      if (!traceColumns.has(name)) {
        this.database.exec(
          `ALTER TABLE local_traces ADD COLUMN ${name} ${declaration}`,
        );
      }
    }
    const spanColumns = new Set(
      (
        this.database.prepare("PRAGMA table_info(local_spans)").all() as Row[]
      ).map((row) => text(row, "name")),
    );
    for (const name of ["started_at", "ended_at", "error"] as const) {
      if (!spanColumns.has(name)) {
        this.database.exec(`ALTER TABLE local_spans ADD COLUMN ${name} TEXT`);
      }
    }
  }
}
