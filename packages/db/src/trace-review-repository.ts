import type { JsonValue } from '@rental/shared'
import type { Db } from './database.js'
import { nowIso } from './database.js'

/**
 * A persisted evaluation of one agent trace, sourced from the legacy
 * evaluateCustomerServiceReply() (or any Evaluator). Mirrors legacy
 * EvaluationResult fields (rag-service/src/rag.ts) so a review is the first-class
 * eval record PRD §10/§16 requires.
 */
export interface TraceReview {
  id: string
  traceId: string
  score: number
  issues: string[]
  suggestions: string[]
  suggestedReply?: string
  evaluatorModel?: string
  promptVersion?: string
  createdAt: string
}

export interface NewTraceReview {
  id: string
  traceId: string
  score: number
  issues?: string[]
  suggestions?: string[]
  suggestedReply?: string
  evaluatorModel?: string
  promptVersion?: string
}

interface TraceReviewRow {
  id: string
  trace_id: string
  score: number
  issues_json: string
  suggestions_json: string
  suggested_reply: string | null
  evaluator_model: string | null
  prompt_version: string | null
  created_at: string
}

/**
 * Converts a snake_case DB row into the camelCase TraceReview, parsing the JSON
 * arrays back into typed values.
 */
function toTraceReview(row: TraceReviewRow): TraceReview {
  return {
    id: row.id,
    traceId: row.trace_id,
    score: row.score,
    issues: JSON.parse(row.issues_json) as string[],
    suggestions: JSON.parse(row.suggestions_json) as string[],
    suggestedReply: row.suggested_reply ?? undefined,
    evaluatorModel: row.evaluator_model ?? undefined,
    promptVersion: row.prompt_version ?? undefined,
    createdAt: row.created_at,
  }
}

export interface TraceReviewRepository {
  append(input: NewTraceReview): TraceReview
  findByTrace(traceId: string): TraceReview[]
}

/**
 * Creates the trace_reviews repository. One trace may carry many reviews (e.g.
 * re-evaluations over time); append is idempotent only by id, not by trace.
 */
export function createTraceReviewRepository(db: Db): TraceReviewRepository {
  return {
    append(input) {
      const ts = nowIso()
      db.prepare(
        `INSERT INTO trace_reviews
           (id, trace_id, score, issues_json, suggestions_json, suggested_reply, evaluator_model, prompt_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.traceId,
        input.score,
        JSON.stringify(input.issues ?? []),
        JSON.stringify(input.suggestions ?? []),
        input.suggestedReply ?? null,
        input.evaluatorModel ?? null,
        input.promptVersion ?? null,
        ts,
      )
      return this.findByTrace(input.traceId).find((r) => r.id === input.id)!
    },

    findByTrace(traceId) {
      const rows = db
        .prepare('SELECT * FROM trace_reviews WHERE trace_id = ? ORDER BY created_at ASC')
        .all(traceId) as TraceReviewRow[]
      return rows.map(toTraceReview)
    },
  }
}

// Re-export so callers can import JsonValue from this module if convenient.
export type { JsonValue }
