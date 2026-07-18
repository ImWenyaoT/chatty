import type { JsonValue } from "@rental/shared";
import type { Db } from "./database.js";
import { nowIso } from "./database.js";

export type DurableTaskStatus =
  "pending" | "in_progress" | "waiting" | "completed" | "cancelled";

export type DurableTaskWaitFor = "customer" | "human" | "time";

export interface DurableTask {
  id: string;
  conversationId: string;
  subject: string;
  description: string;
  status: DurableTaskStatus;
  waitFor?: DurableTaskWaitFor;
  dueAt?: string;
  blockedBy: string[];
  context: JsonValue;
  completionEvidence?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export type DurableTaskCompletionEvidence =
  | {
      kind: "tool_receipt";
      toolName: string;
      receiptId: string;
      traceId?: string;
    }
  | {
      kind: "human_resolution";
      resolutionId: string;
      resolution: string;
      traceId?: string;
    };

export class InvalidDurableTaskTransitionError extends Error {
  constructor(from: DurableTaskStatus, to: DurableTaskStatus) {
    super(`invalid durable task transition: ${from} -> ${to}`);
    this.name = "InvalidDurableTaskTransitionError";
  }
}

/** Stores only unresolved customer goals that must survive beyond one Agent loop. */
export function createDurableTaskRepository(db: Db) {
  const get = (id: string): DurableTask | undefined => {
    const row = db
      .prepare("SELECT * FROM durable_tasks WHERE id = ?")
      .get(id) as DurableTaskRow | undefined;
    return row ? mapTask(row) : undefined;
  };

  return {
    create(input: {
      id: string;
      conversationId: string;
      subject: string;
      description?: string;
      blockedBy?: string[];
      context?: JsonValue;
    }): DurableTask {
      const ts = nowIso();
      db.prepare(
        `INSERT INTO durable_tasks
         (id, conversation_id, subject, description, status, blocked_by_json, context_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.conversationId,
        input.subject,
        input.description ?? "",
        JSON.stringify(input.blockedBy ?? []),
        JSON.stringify(input.context ?? {}),
        ts,
        ts,
      );
      return get(input.id)!;
    },

    get,

    listByConversation(conversationId: string): DurableTask[] {
      return (
        db
          .prepare(
            "SELECT * FROM durable_tasks WHERE conversation_id = ? ORDER BY created_at, id",
          )
          .all(conversationId) as DurableTaskRow[]
      ).map(mapTask);
    },

    findWaiting(
      conversationId: string,
      waitFor: DurableTaskWaitFor,
    ): DurableTask | undefined {
      const row = db
        .prepare(
          `SELECT * FROM durable_tasks
           WHERE conversation_id = ? AND status = 'waiting' AND wait_for = ?
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
        )
        .get(conversationId, waitFor) as DurableTaskRow | undefined;
      return row ? mapTask(row) : undefined;
    },

    findWaitingHumanByRunId(
      conversationId: string,
      runId: string,
    ): DurableTask | undefined {
      const row = db
        .prepare(
          `SELECT * FROM durable_tasks
           WHERE conversation_id = ? AND status = 'waiting' AND wait_for = 'human'
             AND json_extract(context_json, '$.runId') = ?
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
        )
        .get(conversationId, runId) as DurableTaskRow | undefined;
      return row ? mapTask(row) : undefined;
    },

    listDue(now: string): DurableTask[] {
      return (
        db
          .prepare(
            `SELECT * FROM durable_tasks
             WHERE status = 'waiting' AND wait_for = 'time' AND due_at <= ?
             ORDER BY due_at, created_at, id`,
          )
          .all(now) as DurableTaskRow[]
      ).map(mapTask);
    },

    claim(id: string): DurableTask {
      return db.transaction(() => {
        const task = requireTask(get(id), id);
        assertTransition(task, "pending", "in_progress");
        const blocked = task.blockedBy.some(
          (dependencyId) => get(dependencyId)?.status !== "completed",
        );
        if (blocked) throw new Error(`durable task is blocked: ${id}`);
        updateState(db, id, "in_progress");
        return get(id)!;
      })();
    },

    wait(
      id: string,
      waitFor: DurableTaskWaitFor,
      options: { dueAt?: string; context?: JsonValue } = {},
    ): DurableTask {
      const task = requireTask(get(id), id);
      if (
        !(["pending", "in_progress"] as DurableTaskStatus[]).includes(
          task.status,
        )
      ) {
        throw new InvalidDurableTaskTransitionError(task.status, "waiting");
      }
      db.prepare(
        `UPDATE durable_tasks SET status = 'waiting', wait_for = ?, due_at = ?,
         context_json = ?, updated_at = ? WHERE id = ?`,
      ).run(
        waitFor,
        options.dueAt ?? null,
        JSON.stringify(options.context ?? task.context),
        nowIso(),
        id,
      );
      return get(id)!;
    },

    resume(id: string, waitFor: DurableTaskWaitFor): DurableTask {
      const task = requireTask(get(id), id);
      if (task.status !== "waiting" || task.waitFor !== waitFor) {
        throw new InvalidDurableTaskTransitionError(task.status, "in_progress");
      }
      db.prepare(
        `UPDATE durable_tasks SET status = 'in_progress', wait_for = NULL,
         due_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(nowIso(), id);
      return get(id)!;
    },

    complete(id: string, evidence: DurableTaskCompletionEvidence): DurableTask {
      const task = requireTask(get(id), id);
      assertTransition(task, "in_progress", "completed");
      assertCompletionEvidence(evidence);
      db.prepare(
        `UPDATE durable_tasks SET status = 'completed', wait_for = NULL,
         due_at = NULL, completion_evidence_json = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(evidence), nowIso(), id);
      return get(id)!;
    },

    cancel(id: string): DurableTask {
      const task = requireTask(get(id), id);
      if (task.status === "cancelled") return task;
      if (task.status === "completed") {
        throw new InvalidDurableTaskTransitionError(task.status, "cancelled");
      }
      db.prepare(
        `UPDATE durable_tasks SET status = 'cancelled', wait_for = NULL,
         due_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(nowIso(), id);
      return get(id)!;
    },
  };
}

function assertCompletionEvidence(
  evidence: DurableTaskCompletionEvidence,
): void {
  const valid =
    (evidence.kind === "tool_receipt" &&
      Boolean(evidence.toolName.trim()) &&
      Boolean(evidence.receiptId.trim())) ||
    (evidence.kind === "human_resolution" &&
      Boolean(evidence.resolutionId.trim()) &&
      Boolean(evidence.resolution.trim()));
  if (!valid)
    throw new Error("durable task completion requires verified evidence");
}

export type DurableTaskRepository = ReturnType<
  typeof createDurableTaskRepository
>;

function requireTask(task: DurableTask | undefined, id: string): DurableTask {
  if (!task) throw new Error(`durable task not found: ${id}`);
  return task;
}

function assertTransition(
  task: DurableTask,
  from: DurableTaskStatus,
  to: DurableTaskStatus,
): void {
  if (task.status !== from) {
    throw new InvalidDurableTaskTransitionError(task.status, to);
  }
}

function updateState(db: Db, id: string, status: DurableTaskStatus): void {
  db.prepare(
    "UPDATE durable_tasks SET status = ?, updated_at = ? WHERE id = ?",
  ).run(status, nowIso(), id);
}

interface DurableTaskRow {
  id: string;
  conversation_id: string;
  subject: string;
  description: string;
  status: DurableTaskStatus;
  wait_for: DurableTaskWaitFor | null;
  due_at: string | null;
  blocked_by_json: string;
  context_json: string;
  completion_evidence_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapTask(row: DurableTaskRow): DurableTask {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    waitFor: row.wait_for ?? undefined,
    dueAt: row.due_at ?? undefined,
    blockedBy: JSON.parse(row.blocked_by_json) as string[],
    context: JSON.parse(row.context_json) as JsonValue,
    completionEvidence: row.completion_evidence_json
      ? (JSON.parse(row.completion_evidence_json) as JsonValue)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
