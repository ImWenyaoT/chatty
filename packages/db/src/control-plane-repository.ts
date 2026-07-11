import type { JsonValue } from '@rental/shared'
import type { Db } from './database.js'
import { nowIso } from './database.js'

export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'waiting_for_approval'
  | 'waiting_for_handoff'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type BackgroundJobType = 'memory_extract' | 'memory_consolidate' | 'scheduled_followup'
export type BackgroundJobStatus =
  'pending' | 'running' | 'succeeded' | 'succeeded_no_output' | 'failed' | 'cancelled'

export interface WorkflowRun {
  id: string
  sessionId: string
  conversationId: string
  idempotencyKey: string
  status: WorkflowRunStatus
  version: number
  failureKind?: string
  result?: JsonValue
  cancelRequestedAt?: string
  cancelReason?: string
  leaseOwner?: string
  leaseExpiresAt?: string
  heartbeatAt?: string
  createdAt: string
  updatedAt: string
}

export interface WorkflowEvent {
  runId: string
  sequence: number
  type: string
  payload: JsonValue
  createdAt: string
}

export interface QueuedConversationEvent {
  id: number
  event: JsonValue
}

export interface ConversationCheckpoint {
  id: string
  conversationId: string
  throughTraceId: string
  version: number
  summary: JsonValue
  tokenBefore: number
  tokenAfter: number
  model: string
  createdAt: string
}

export interface MemoryCandidate {
  id: string
  customerId: string
  conversationId: string
  sourceTraceId: string
  category: string
  key: string
  value: JsonValue
  confidence: number
  sensitivity: string
  status: 'candidate' | 'promoted' | 'pruned' | 'rejected'
  usageCount: number
  lastUsedAt?: string
  createdAt: string
  updatedAt: string
}

export interface BackgroundJob {
  id: string
  type: BackgroundJobType
  status: BackgroundJobStatus
  conversationId?: string
  customerId?: string
  payload: JsonValue
  dueAt: string
  attempts: number
  maxAttempts: number
  leaseOwner?: string
  claimFence: number
  leaseExpiresAt?: string
  heartbeatAt?: string
  lastError?: string
  runId?: string
  createdAt: string
  updatedAt: string
}

export interface OutboxMessage {
  id: string
  conversationId: string
  runId: string
  payload: JsonValue
  status: 'pending' | 'sent'
  idempotencyKey: string
  createdAt: string
}

export interface ExtractedMemoryCandidate {
  id: string
  sourceTraceId: string
  category: 'preference' | 'measurement' | 'delivery' | 'service_history'
  key: string
  value: JsonValue
  confidence: number
  sensitivity: 'normal' | 'sensitive'
}

export class ConversationBusyError extends Error {
  constructor(conversationId: string) {
    super(`conversation already has an active run: ${conversationId}`)
    this.name = 'ConversationBusyError'
  }
}

export class InvalidWorkflowTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`invalid workflow transition: ${from} -> ${to}`)
    this.name = 'InvalidWorkflowTransitionError'
  }
}

const RUN_TRANSITIONS: Record<WorkflowRunStatus, WorkflowRunStatus[]> = {
  queued: ['running', 'cancelled'],
  running: [
    'waiting_for_user',
    'waiting_for_approval',
    'waiting_for_handoff',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ],
  waiting_for_user: ['completed'],
  waiting_for_approval: ['running', 'cancelled'],
  waiting_for_handoff: ['running', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/** Owns durable workflow, checkpoint, memory, job, and outbox state in SQLite. */
export function createControlPlaneRepository(db: Db) {
  return {
    startRun(input: {
      id: string
      sessionId: string
      conversationId: string
      idempotencyKey: string
    }): WorkflowRun {
      const existing = db
        .prepare('SELECT * FROM workflow_runs WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as WorkflowRunRow | undefined
      if (existing) return mapRun(existing)
      const ts = nowIso()
      try {
        db.prepare(
          `INSERT INTO workflow_runs
           (id, session_id, conversation_id, idempotency_key, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', 1, ?, ?)`,
        ).run(input.id, input.sessionId, input.conversationId, input.idempotencyKey, ts, ts)
      } catch (error) {
        const message = String(error)
        if (
          message.includes('idx_workflow_runs_active_conversation') ||
          message.includes('workflow_runs.conversation_id')
        ) {
          throw new ConversationBusyError(input.conversationId)
        }
        throw error
      }
      return this.getRun(input.id)!
    },

    getRun(id: string): WorkflowRun | undefined {
      const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as
        WorkflowRunRow | undefined
      return row ? mapRun(row) : undefined
    },

    /** Counts durable queued inputs that have not completed for one conversation. */
    countQueuedConversationEvents(conversationId: string): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM conversation_event_queue
           WHERE conversation_id = ? AND status IN ('pending','processing')`,
        )
        .get(conversationId) as { count: number }
      return Number(row.count)
    },

    /** Counts workflows in one durable status for aggregate health reporting. */
    countRunsByStatus(status: WorkflowRunStatus): number {
      const row = db
        .prepare('SELECT COUNT(*) AS count FROM workflow_runs WHERE status = ?')
        .get(status) as { count: number }
      return Number(row.count)
    },

    /** Aggregates all durable jobs without applying the operations-list display limit. */
    aggregateJobHealth(): {
      memoryNoOps: number
      attemptedJobs: number
      retriedJobs: number
      followupLatencyMs: number | null
    } {
      const row = db
        .prepare(
          `SELECT
        SUM(CASE WHEN type = 'memory_extract' AND status = 'succeeded_no_output' THEN 1 ELSE 0 END) AS memory_no_ops,
        SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS attempted_jobs,
        SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS retried_jobs,
        AVG(CASE WHEN type = 'scheduled_followup' AND status = 'succeeded'
          THEN (julianday(updated_at) - julianday(created_at)) * 86400000 END) AS followup_latency_ms
        FROM background_jobs`,
        )
        .get() as {
        memory_no_ops: number | null
        attempted_jobs: number | null
        retried_jobs: number | null
        followup_latency_ms: number | null
      }
      return {
        memoryNoOps: Number(row.memory_no_ops ?? 0),
        attemptedJobs: Number(row.attempted_jobs ?? 0),
        retriedJobs: Number(row.retried_jobs ?? 0),
        followupLatencyMs:
          row.followup_latency_ms === null ? null : Math.max(0, row.followup_latency_ms),
      }
    },

    /** Finds the durable workflow associated with one externally supplied request identity. */
    getRunByIdempotencyKey(idempotencyKey: string): WorkflowRun | undefined {
      const row = db
        .prepare('SELECT * FROM workflow_runs WHERE idempotency_key = ?')
        .get(idempotencyKey) as WorkflowRunRow | undefined
      return row ? mapRun(row) : undefined
    },

    /** Durably requests cancellation and terminally fences the run from further owner writes. */
    requestRunCancellation(id: string, reason = 'explicit_cancel'): WorkflowRun {
      return db.transaction(() => {
        const current = this.getRun(id)
        if (!current) throw new Error(`workflow run not found: ${id}`)
        if (current.cancelRequestedAt) return current
        const ts = nowIso()
        const result = db
          .prepare(
            `UPDATE workflow_runs SET status = 'cancelled', cancel_requested_at = ?,
             cancel_reason = ?, finished_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`,
          )
          .run(ts, reason, ts, ts, id)
        if (result.changes !== 1) return this.getRun(id)!
        this.appendRunEvent(id, 'cancel_requested', { reason })
        this.appendRunEvent(id, 'state_changed', { status: 'cancelled', reason })
        return this.getRun(id)!
      })()
    },

    /** Lists workflows whose queued or expired lease state makes them eligible for recovery. */
    listRecoverableRuns(now: string): WorkflowRun[] {
      return (
        db
          .prepare(
            `SELECT * FROM workflow_runs WHERE status = 'queued' OR
         (status IN ('running','paused') AND lease_expires_at < ?)
         ORDER BY created_at`,
          )
          .all(now) as WorkflowRunRow[]
      ).map(mapRun)
    },

    /** Persists the externally replayable result while the workflow owner still holds its lease. */
    saveRunResult(id: string, owner: string, result: JsonValue): boolean {
      return (
        db
          .prepare(
            `UPDATE workflow_runs SET result_json = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
          )
          .run(JSON.stringify(result), nowIso(), id, owner).changes === 1
      )
    },

    transitionRun(
      id: string,
      status: WorkflowRunStatus,
      failureKind?: string,
      leaseOwner?: string,
    ): WorkflowRun {
      const current = this.getRun(id)
      if (!current) throw new Error(`workflow run not found: ${id}`)
      if (!RUN_TRANSITIONS[current.status].includes(status)) {
        throw new InvalidWorkflowTransitionError(current.status, status)
      }
      const ts = nowIso()
      const result = db
        .prepare(
          `UPDATE workflow_runs SET status = ?, version = version + 1, failure_kind = ?,
         started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
         finished_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE finished_at END,
         updated_at = ? WHERE id = ? AND (? IS NULL OR lease_owner = ?)`,
        )
        .run(
          status,
          failureKind ?? null,
          status,
          ts,
          status,
          ts,
          ts,
          id,
          leaseOwner ?? null,
          leaseOwner ?? null,
        )
      if (result.changes !== 1) throw new Error(`workflow lease lost: ${id}`)
      return this.getRun(id)!
    },

    /** Claims a queued run or an expired active run with a renewable workflow lease. */
    claimRun(id: string, owner: string, now: string, leaseMs = 60_000): WorkflowRun | undefined {
      return db.transaction(() => {
        const expiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString()
        const result = db
          .prepare(
            `UPDATE workflow_runs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
           heartbeat_at = ?, started_at = COALESCE(started_at, ?), version = version + 1, updated_at = ?
           WHERE id = ? AND (status = 'queued' OR
             (status IN ('running','paused') AND lease_expires_at < ?))`,
          )
          .run(owner, expiresAt, now, now, now, id, now)
        return result.changes === 1 ? this.getRun(id) : undefined
      })()
    },

    /** Extends a workflow lease only while its current owner still holds it. */
    heartbeatRun(id: string, owner: string, now: string, leaseMs = 60_000): boolean {
      const expiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString()
      return (
        db
          .prepare(
            `UPDATE workflow_runs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at >= ?`,
          )
          .run(now, expiresAt, now, id, owner, now).changes === 1
      )
    },

    /** Resumes a human handoff by issuing a fresh execution lease to an explicit owner. */
    resumeHandoff(
      id: string,
      owner: string,
      now: string,
      leaseMs = 60_000,
    ): WorkflowRun | undefined {
      const expiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString()
      const result = db
        .prepare(
          `UPDATE workflow_runs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
         heartbeat_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'waiting_for_handoff'`,
        )
        .run(owner, expiresAt, now, now, id)
      return result.changes === 1 ? this.getRun(id) : undefined
    },

    appendRunEvent(runId: string, type: string, payload: JsonValue = {}): WorkflowEvent {
      return db.transaction(() => {
        const sequence = Number(
          (
            db
              .prepare(
                'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM workflow_events WHERE run_id = ?',
              )
              .get(runId) as { next: number }
          ).next,
        )
        const createdAt = nowIso()
        db.prepare(
          'INSERT INTO workflow_events (run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(runId, sequence, type, JSON.stringify(payload), createdAt)
        return { runId, sequence, type, payload, createdAt }
      })()
    },

    listRunEvents(runId: string): WorkflowEvent[] {
      return (
        db
          .prepare('SELECT * FROM workflow_events WHERE run_id = ? ORDER BY sequence')
          .all(runId) as WorkflowEventRow[]
      ).map(mapWorkflowEvent)
    },

    /** Aggregates one durable workflow event type for control-plane health metrics. */
    countRunEventsByType(type: string): number {
      return Number(
        (
          db.prepare('SELECT COUNT(*) AS count FROM workflow_events WHERE type = ?').get(type) as {
            count: number
          }
        ).count,
      )
    },

    enqueueConversationEvent(
      conversationId: string,
      idempotencyKey: string,
      event: JsonValue,
    ): number {
      const existing = db
        .prepare('SELECT id FROM conversation_event_queue WHERE idempotency_key = ?')
        .get(idempotencyKey) as { id: number } | undefined
      if (existing) return existing.id
      const result = db
        .prepare(
          `INSERT INTO conversation_event_queue (conversation_id, event_json, status, idempotency_key, created_at)
           VALUES (?, ?, 'pending', ?, ?)`,
        )
        .run(conversationId, JSON.stringify(event), idempotencyKey, nowIso())
      return Number(result.lastInsertRowid)
    },

    dequeueConversationEvent(conversationId: string): JsonValue | undefined {
      return db.transaction(() => {
        const row = db
          .prepare(
            `SELECT id, event_json FROM conversation_event_queue
             WHERE conversation_id = ? AND status = 'pending' ORDER BY id LIMIT 1`,
          )
          .get(conversationId) as { id: number; event_json: string } | undefined
        if (!row) return undefined
        db.prepare("UPDATE conversation_event_queue SET status = 'consumed' WHERE id = ?").run(
          row.id,
        )
        return JSON.parse(row.event_json) as JsonValue
      })()
    },

    /** Claims the FIFO head without deleting it so failed dispatch can be retried. */
    claimConversationEvent(conversationId: string): QueuedConversationEvent | undefined {
      return db.transaction(() => {
        const row = db
          .prepare(
            `SELECT id, event_json FROM conversation_event_queue
           WHERE conversation_id = ? AND status = 'pending' ORDER BY id LIMIT 1`,
          )
          .get(conversationId) as { id: number; event_json: string } | undefined
        if (!row) return undefined
        const changed = db
          .prepare(
            `UPDATE conversation_event_queue SET status = 'processing'
           WHERE id = ? AND status = 'pending'`,
          )
          .run(row.id)
        return changed.changes === 1
          ? { id: row.id, event: JSON.parse(row.event_json) as JsonValue }
          : undefined
      })()
    },

    /** Acknowledges a queued event only after its Customer Service Turn succeeds. */
    completeConversationEvent(id: number): boolean {
      return (
        db
          .prepare(
            `UPDATE conversation_event_queue SET status = 'consumed'
         WHERE id = ? AND status = 'processing'`,
          )
          .run(id).changes === 1
      )
    },

    /** Releases a failed queued dispatch back to the FIFO head for later recovery. */
    releaseConversationEvent(id: number): boolean {
      return (
        db
          .prepare(
            `UPDATE conversation_event_queue SET status = 'pending'
         WHERE id = ? AND status = 'processing'`,
          )
          .run(id).changes === 1
      )
    },

    /** Returns queue claims interrupted by the previous process to pending during startup recovery. */
    releaseInterruptedConversationEvents(): number {
      return db
        .prepare(
          `UPDATE conversation_event_queue SET status = 'pending' WHERE status = 'processing'`,
        )
        .run().changes
    },

    saveCheckpoint(
      input: Omit<ConversationCheckpoint, 'version' | 'createdAt'>,
    ): ConversationCheckpoint {
      const version = Number(
        (
          db
            .prepare(
              'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM conversation_checkpoints WHERE conversation_id = ?',
            )
            .get(input.conversationId) as { next: number }
        ).next,
      )
      const createdAt = nowIso()
      db.prepare(
        `INSERT INTO conversation_checkpoints
         (id, conversation_id, through_trace_id, version, summary_json, token_before, token_after, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.conversationId,
        input.throughTraceId,
        version,
        JSON.stringify(input.summary),
        input.tokenBefore,
        input.tokenAfter,
        input.model,
        createdAt,
      )
      return { ...input, version, createdAt }
    },

    latestCheckpoint(conversationId: string): ConversationCheckpoint | undefined {
      const row = db
        .prepare(
          'SELECT * FROM conversation_checkpoints WHERE conversation_id = ? ORDER BY version DESC LIMIT 1',
        )
        .get(conversationId) as CheckpointRow | undefined
      return row ? mapCheckpoint(row) : undefined
    },

    insertMemoryCandidate(
      input: Omit<MemoryCandidate, 'usageCount' | 'createdAt' | 'updatedAt'>,
    ): MemoryCandidate {
      const ts = nowIso()
      db.prepare(
        `INSERT OR IGNORE INTO memory_candidates
         (id, customer_id, conversation_id, source_trace_id, category, memory_key, value_json, confidence, sensitivity, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.customerId,
        input.conversationId,
        input.sourceTraceId,
        input.category,
        input.key,
        JSON.stringify(input.value),
        input.confidence,
        input.sensitivity,
        input.status,
        ts,
        ts,
      )
      return this.listMemoryCandidates(input.customerId).find((entry) => entry.id === input.id)!
    },

    listMemoryCandidates(
      customerId: string,
      status?: MemoryCandidate['status'],
    ): MemoryCandidate[] {
      const rows = status
        ? db
            .prepare(
              'SELECT * FROM memory_candidates WHERE customer_id = ? AND status = ? ORDER BY usage_count DESC, updated_at DESC',
            )
            .all(customerId, status)
        : db
            .prepare(
              'SELECT * FROM memory_candidates WHERE customer_id = ? ORDER BY usage_count DESC, updated_at DESC',
            )
            .all(customerId)
      return (rows as MemoryCandidateRow[]).map(mapMemoryCandidate)
    },

    markMemoryUsed(ids: string[]): void {
      const statement = db.prepare(
        'UPDATE memory_candidates SET usage_count = usage_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?',
      )
      const ts = nowIso()
      db.transaction(() => ids.forEach((id) => statement.run(ts, ts, id)))()
    },

    setMemoryStatus(id: string, status: MemoryCandidate['status']): void {
      db.prepare('UPDATE memory_candidates SET status = ?, updated_at = ? WHERE id = ?').run(
        status,
        nowIso(),
        id,
      )
    },

    /** Atomically stores extraction output and completes its exact fenced job claim. */
    completeMemoryExtraction(
      id: string,
      workerId: string,
      claimFence: number,
      input: {
        customerId: string
        conversationId: string
        productId: string
        conversationSummary: string
        candidates: ExtractedMemoryCandidate[]
      },
      observedAt = nowIso(),
    ): boolean {
      return db.transaction(() => {
        if (!this.ownsJobClaim(id, workerId, claimFence, observedAt)) return false
        const ts = nowIso()
        const insert = db.prepare(
          `INSERT INTO memory_candidates
           (id, customer_id, conversation_id, source_trace_id, category, memory_key, value_json,
            confidence, sensitivity, status, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM memory_candidates WHERE customer_id = ? AND conversation_id = ?
             AND source_trace_id = ? AND category = ? AND memory_key = ? AND value_json = ?
           )`,
        )
        let produced = 0
        for (const candidate of input.candidates) {
          produced += insert.run(
            candidate.id,
            input.customerId,
            input.conversationId,
            candidate.sourceTraceId,
            candidate.category,
            candidate.key,
            JSON.stringify(candidate.value),
            candidate.confidence,
            candidate.sensitivity,
            ts,
            ts,
            input.customerId,
            input.conversationId,
            candidate.sourceTraceId,
            candidate.category,
            candidate.key,
            JSON.stringify(candidate.value),
          ).changes
        }
        db.prepare(
          `INSERT INTO product_memories
           (conversation_id, customer_id, product_id, summary, recent_messages_json,
            conversation_profile_json, reviews_json, updated_at)
           VALUES (?, ?, ?, ?, '[]', '{}', '[]', ?)
           ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
        ).run(
          input.conversationId,
          input.customerId,
          input.productId,
          input.conversationSummary,
          ts,
        )
        return this.finishJob(
          id,
          produced === 0 ? 'succeeded_no_output' : 'succeeded',
          { produced },
          workerId,
          claimFence,
        )
      })()
    },

    /** Atomically promotes, prunes, and replaces a summary under one fenced global lease. */
    completeMemoryConsolidation(
      id: string,
      workerId: string,
      claimFence: number,
      input: {
        customerId: string
        globalSummary: string
        promotedIds: string[]
        prunedIds: string[]
      },
      observedAt = nowIso(),
    ): boolean {
      return db.transaction(() => {
        if (!this.ownsJobClaim(id, workerId, claimFence, observedAt)) return false
        const overlap = input.promotedIds.find((candidateId) =>
          input.prunedIds.includes(candidateId),
        )
        if (overlap) throw new Error(`candidate cannot be promoted and pruned: ${overlap}`)
        const ts = nowIso()
        const update = db.prepare(
          `UPDATE memory_candidates SET status = ?, updated_at = ?
           WHERE id = ? AND customer_id = ? AND status = 'candidate'`,
        )
        for (const candidateId of input.promotedIds) {
          if (update.run('promoted', ts, candidateId, input.customerId).changes !== 1) {
            throw new Error(`candidate is not promotable: ${candidateId}`)
          }
        }
        for (const candidateId of input.prunedIds) {
          if (update.run('pruned', ts, candidateId, input.customerId).changes !== 1) {
            throw new Error(`candidate is not prunable: ${candidateId}`)
          }
        }
        if (input.promotedIds.length + input.prunedIds.length > 0) {
          db.prepare(
            `INSERT INTO customer_memories
           (customer_id, global_summary, session_context_json, body_profiles_json, updated_at)
           VALUES (?, ?, '{}', '[]', ?)
           ON CONFLICT(customer_id) DO UPDATE SET global_summary = excluded.global_summary,
             updated_at = excluded.updated_at`,
          ).run(input.customerId, input.globalSummary, ts)
        }
        return this.finishJob(
          id,
          input.promotedIds.length + input.prunedIds.length === 0
            ? 'succeeded_no_output'
            : 'succeeded',
          { promoted: input.promotedIds.length, pruned: input.prunedIds.length },
          workerId,
          claimFence,
        )
      })()
    },

    enqueueJob(input: {
      id: string
      type: BackgroundJobType
      conversationId?: string
      customerId?: string
      payload: JsonValue
      dueAt: string
      idempotencyKey: string
      maxAttempts?: number
    }): BackgroundJob {
      const existing = db
        .prepare('SELECT * FROM background_jobs WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as BackgroundJobRow | undefined
      if (existing) return mapJob(existing)
      const ts = nowIso()
      db.prepare(
        `INSERT INTO background_jobs
         (id, type, status, conversation_id, customer_id, payload_json, due_at, max_attempts, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.type,
        input.conversationId ?? null,
        input.customerId ?? null,
        JSON.stringify(input.payload),
        input.dueAt,
        input.maxAttempts ?? 3,
        input.idempotencyKey,
        ts,
        ts,
      )
      this.appendJobEvent(input.id, 'scheduled', { dueAt: input.dueAt })
      return this.getJob(input.id)!
    },

    /** Coalesces one conversation's extraction work and moves its cooling deadline forward. */
    scheduleMemoryExtraction(input: {
      id: string
      conversationId: string
      customerId: string
      payload: JsonValue
      now: string
      coolingMs?: number
    }): BackgroundJob {
      return db.transaction(() => {
        const pending = db
          .prepare(
            `SELECT * FROM background_jobs WHERE type = 'memory_extract' AND conversation_id = ?
             AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
          )
          .get(input.conversationId) as BackgroundJobRow | undefined
        const dueAt = new Date(
          new Date(input.now).getTime() + (input.coolingMs ?? 86_400_000),
        ).toISOString()
        if (!pending) {
          return this.enqueueJob({
            id: input.id,
            type: 'memory_extract',
            conversationId: input.conversationId,
            customerId: input.customerId,
            payload: input.payload,
            dueAt,
            idempotencyKey: `memory-extract:${input.conversationId}:${input.id}`,
          })
        }
        db.prepare(
          `UPDATE background_jobs SET payload_json = ?, due_at = CASE WHEN status = 'pending' THEN ? ELSE due_at END,
           updated_at = ? WHERE id = ?`,
        ).run(JSON.stringify(input.payload), dueAt, input.now, pending.id)
        this.appendJobEvent(pending.id, 'coalesced', { dueAt })
        return this.getJob(pending.id)!
      })()
    },

    /** Coalesces global consolidation demand behind one pending or leased job. */
    scheduleMemoryConsolidation(input: {
      id: string
      customerId: string
      now: string
    }): BackgroundJob {
      return db.transaction(() => {
        const active = db
          .prepare(
            `SELECT * FROM background_jobs WHERE type = 'memory_consolidate'
           AND customer_id = ? AND status IN ('pending','running') ORDER BY created_at LIMIT 1`,
          )
          .get(input.customerId) as BackgroundJobRow | undefined
        if (active) {
          this.appendJobEvent(active.id, 'coalesced', { customerId: input.customerId })
          return mapJob(active)
        }
        return this.enqueueJob({
          id: input.id,
          type: 'memory_consolidate',
          customerId: input.customerId,
          payload: {},
          dueAt: input.now,
          idempotencyKey: `memory-consolidate:${input.id}`,
        })
      })()
    },

    getJob(id: string): BackgroundJob | undefined {
      const row = db.prepare('SELECT * FROM background_jobs WHERE id = ?').get(id) as
        BackgroundJobRow | undefined
      return row ? mapJob(row) : undefined
    },

    linkJobRun(id: string, runId: string): void {
      db.prepare('UPDATE background_jobs SET run_id = ?, updated_at = ? WHERE id = ?').run(
        runId,
        nowIso(),
        id,
      )
    },

    listJobs(limit = 100): BackgroundJob[] {
      return (
        db
          .prepare('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?')
          .all(limit) as BackgroundJobRow[]
      ).map(mapJob)
    },

    claimDueJob(workerId: string, now: string, leaseMs = 60_000): BackgroundJob | undefined {
      return db.transaction(() => {
        const row = db
          .prepare(
            `SELECT * FROM background_jobs
           WHERE attempts < max_attempts AND due_at <= ? AND
             (status = 'pending' OR (status = 'running' AND lease_expires_at < ?))
             AND (type != 'memory_consolidate' OR status = 'running' OR NOT EXISTS (
               SELECT 1 FROM background_jobs leased WHERE leased.type = 'memory_consolidate'
               AND leased.status = 'running' AND leased.lease_expires_at >= ?
             ))
           ORDER BY due_at, created_at LIMIT 1`,
          )
          .get(now, now, now) as BackgroundJobRow | undefined
        if (!row) return undefined
        const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString()
        const claimedResult = db
          .prepare(
            `UPDATE background_jobs SET status = 'running', attempts = attempts + 1,
           lease_owner = ?, claim_fence = claim_fence + 1, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND claim_fence = ? AND
           (status = 'pending' OR (status = 'running' AND lease_expires_at < ?))`,
          )
          .run(workerId, leaseExpiresAt, now, now, row.id, row.claim_fence, now)
        if (claimedResult.changes !== 1) return undefined
        const claimed = this.getJob(row.id)!
        this.appendJobEvent(row.id, 'claimed', {
          workerId,
          claimFence: claimed.claimFence,
          leaseExpiresAt,
        })
        return claimed
      })()
    },

    heartbeatJob(
      id: string,
      workerId: string,
      claimFence: number,
      leaseExpiresAt: string,
      observedAt = nowIso(),
    ): boolean {
      const result = db
        .prepare(
          `UPDATE background_jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND claim_fence = ?
         AND lease_expires_at >= ?`,
        )
        .run(observedAt, leaseExpiresAt, observedAt, id, workerId, claimFence, observedAt)
      return result.changes === 1
    },

    /** Checks whether one exact leased claim is still the only valid writer. */
    ownsJobClaim(id: string, workerId: string, claimFence: number, now?: string): boolean {
      const row = now
        ? db
            .prepare(
              `SELECT 1 FROM background_jobs WHERE id = ? AND status = 'running'
             AND lease_owner = ? AND claim_fence = ? AND lease_expires_at >= ?`,
            )
            .get(id, workerId, claimFence, now)
        : db
            .prepare(
              `SELECT 1 FROM background_jobs WHERE id = ? AND status = 'running'
             AND lease_owner = ? AND claim_fence = ?`,
            )
            .get(id, workerId, claimFence)
      return row !== undefined
    },

    finishJob(
      id: string,
      status: 'succeeded' | 'succeeded_no_output',
      payload: JsonValue = {},
      workerId?: string,
      claimFence?: number,
    ): boolean {
      const now = nowIso()
      const result = db
        .prepare(
          `UPDATE background_jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_error = NULL, updated_at = ? WHERE id = ? AND status = 'running'
         AND (? IS NULL OR lease_owner = ?) AND (? IS NULL OR claim_fence = ?)
         `,
        )
        .run(
          status,
          now,
          id,
          workerId ?? null,
          workerId ?? null,
          claimFence ?? null,
          claimFence ?? null,
        )
      if (result.changes) this.appendJobEvent(id, status, payload)
      return result.changes === 1
    },

    failJob(
      id: string,
      error: string,
      retryAt?: string,
      workerId?: string,
      claimFence?: number,
    ): boolean {
      const job = this.getJob(id)
      if (!job) throw new Error(`background job not found: ${id}`)
      const terminal = job.attempts >= job.maxAttempts
      const now = nowIso()
      const result = db
        .prepare(
          `UPDATE background_jobs SET status = ?, due_at = ?, lease_owner = NULL,
         lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?
         AND status = 'running' AND (? IS NULL OR lease_owner = ?)
         AND (? IS NULL OR claim_fence = ?)
         `,
        )
        .run(
          terminal ? 'failed' : 'pending',
          retryAt ?? job.dueAt,
          error,
          now,
          id,
          workerId ?? null,
          workerId ?? null,
          claimFence ?? null,
          claimFence ?? null,
        )
      if (result.changes) {
        this.appendJobEvent(id, terminal ? 'failed' : 'retry_scheduled', {
          error,
          retryAt: retryAt ?? job.dueAt,
        })
      }
      return result.changes === 1
    },

    cancelJob(id: string): boolean {
      const result = db
        .prepare(
          `UPDATE background_jobs SET status = 'cancelled', lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','running')`,
        )
        .run(nowIso(), id)
      if (result.changes) this.appendJobEvent(id, 'cancelled')
      return result.changes === 1
    },

    retryJob(id: string, dueAt = nowIso()): boolean {
      const result = db
        .prepare(
          `UPDATE background_jobs SET status = 'pending', due_at = ?, last_error = NULL,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed'`,
        )
        .run(dueAt, nowIso(), id)
      if (result.changes) this.appendJobEvent(id, 'retried')
      return result.changes === 1
    },

    appendJobEvent(jobId: string, type: string, payload: JsonValue = {}): void {
      db.prepare(
        'INSERT INTO background_job_events (job_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).run(jobId, type, JSON.stringify(payload), nowIso())
    },

    /** Lists one job's durable audit events in insertion order. */
    listJobEvents(jobId: string): { type: string; payload: JsonValue; createdAt: string }[] {
      return (
        db
          .prepare(
            'SELECT type, payload_json, created_at FROM background_job_events WHERE job_id = ? ORDER BY id',
          )
          .all(jobId) as { type: string; payload_json: string; created_at: string }[]
      ).map((row) => ({
        type: row.type,
        payload: JSON.parse(row.payload_json) as JsonValue,
        createdAt: row.created_at,
      }))
    },

    appendOutbox(input: Omit<OutboxMessage, 'status' | 'createdAt'>): OutboxMessage {
      const ts = nowIso()
      db.prepare(
        `INSERT OR IGNORE INTO outbox_messages
         (id, conversation_id, run_id, payload_json, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        input.id,
        input.conversationId,
        input.runId,
        JSON.stringify(input.payload),
        input.idempotencyKey,
        ts,
      )
      return { ...input, status: 'pending', createdAt: ts }
    },

    /** Atomically publishes one follow-up result and completes its exact fenced claim. */
    completeFollowup(
      id: string,
      workerId: string,
      claimFence: number,
      input: Omit<OutboxMessage, 'status' | 'createdAt'>,
      event: JsonValue = {},
    ): boolean {
      return db.transaction(() => {
        const owned = this.ownsJobClaim(id, workerId, claimFence)
        if (!owned) {
          this.appendJobEvent(id, 'completion_rejected', { workerId, claimFence })
          return false
        }
        const ts = nowIso()
        const outboxResult = db
          .prepare(
            `INSERT OR IGNORE INTO outbox_messages
             (id, conversation_id, run_id, payload_json, status, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            input.id,
            input.conversationId,
            input.runId,
            JSON.stringify(input.payload),
            input.idempotencyKey,
            ts,
          )
        if (outboxResult.changes !== 1) {
          const existing = db
            .prepare('SELECT id, run_id FROM outbox_messages WHERE idempotency_key = ?')
            .get(input.idempotencyKey) as { id: string; run_id: string } | undefined
          if (!existing || existing.id !== input.id || existing.run_id !== input.runId) {
            throw new Error(`outbox idempotency conflict: ${input.idempotencyKey}`)
          }
          this.appendJobEvent(id, 'outbox_deduplicated', {
            idempotencyKey: input.idempotencyKey,
          })
        }
        const result = db
          .prepare(
            `UPDATE background_jobs SET status = 'succeeded', run_id = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?
             AND status = 'running' AND lease_owner = ? AND claim_fence = ?`,
          )
          .run(input.runId, nowIso(), id, workerId, claimFence)
        if (result.changes !== 1) throw new Error(`background job lease lost: ${id}`)
        this.appendJobEvent(id, 'succeeded', event)
        return true
      })()
    },

    listOutbox(limit = 100): OutboxMessage[] {
      return (
        db
          .prepare('SELECT * FROM outbox_messages ORDER BY created_at DESC LIMIT ?')
          .all(limit) as OutboxRow[]
      ).map(mapOutbox)
    },
  }
}

export type ControlPlaneRepository = ReturnType<typeof createControlPlaneRepository>

interface WorkflowRunRow {
  id: string
  session_id: string
  conversation_id: string
  idempotency_key: string
  status: WorkflowRunStatus
  version: number
  failure_kind: string | null
  result_json: string | null
  cancel_requested_at: string | null
  cancel_reason: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  created_at: string
  updated_at: string
}
interface WorkflowEventRow {
  run_id: string
  sequence: number
  type: string
  payload_json: string
  created_at: string
}
interface CheckpointRow {
  id: string
  conversation_id: string
  through_trace_id: string
  version: number
  summary_json: string
  token_before: number
  token_after: number
  model: string
  created_at: string
}
interface MemoryCandidateRow {
  id: string
  customer_id: string
  conversation_id: string
  source_trace_id: string
  category: string
  memory_key: string
  value_json: string
  confidence: number
  sensitivity: string
  status: MemoryCandidate['status']
  usage_count: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}
interface BackgroundJobRow {
  id: string
  type: BackgroundJobType
  status: BackgroundJobStatus
  conversation_id: string | null
  customer_id: string | null
  payload_json: string
  due_at: string
  attempts: number
  max_attempts: number
  lease_owner: string | null
  claim_fence: number
  lease_expires_at: string | null
  heartbeat_at: string | null
  last_error: string | null
  run_id: string | null
  created_at: string
  updated_at: string
}
interface OutboxRow {
  id: string
  conversation_id: string
  run_id: string
  payload_json: string
  status: 'pending' | 'sent'
  idempotency_key: string
  created_at: string
}

/** Maps one SQLite workflow row to its public domain shape. */
function mapRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    version: row.version,
    failureKind: row.failure_kind ?? undefined,
    result: row.result_json ? (JSON.parse(row.result_json) as JsonValue) : undefined,
    cancelRequestedAt: row.cancel_requested_at ?? undefined,
    cancelReason: row.cancel_reason ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
/** Maps one SQLite workflow-event row to its public domain shape. */
function mapWorkflowEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    payload: JSON.parse(row.payload_json) as JsonValue,
    createdAt: row.created_at,
  }
}
/** Maps one SQLite checkpoint row to its public domain shape. */
function mapCheckpoint(row: CheckpointRow): ConversationCheckpoint {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    throughTraceId: row.through_trace_id,
    version: row.version,
    summary: JSON.parse(row.summary_json) as JsonValue,
    tokenBefore: row.token_before,
    tokenAfter: row.token_after,
    model: row.model,
    createdAt: row.created_at,
  }
}
/** Maps one SQLite memory-candidate row to its public domain shape. */
function mapMemoryCandidate(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    sourceTraceId: row.source_trace_id,
    category: row.category,
    key: row.memory_key,
    value: JSON.parse(row.value_json) as JsonValue,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    status: row.status,
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
/** Maps one SQLite background-job row to its public domain shape. */
function mapJob(row: BackgroundJobRow): BackgroundJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    conversationId: row.conversation_id ?? undefined,
    customerId: row.customer_id ?? undefined,
    payload: JSON.parse(row.payload_json) as JsonValue,
    dueAt: row.due_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner ?? undefined,
    claimFence: row.claim_fence,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    lastError: row.last_error ?? undefined,
    runId: row.run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
/** Maps one SQLite outbox row to its public domain shape. */
function mapOutbox(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    payload: JSON.parse(row.payload_json) as JsonValue,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  }
}
