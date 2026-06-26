import type { JsonValue } from '@rental/shared'
import type { Db } from './database.js'
import { nowIso } from './database.js'

/**
 * Status of a failure case in the regression loop (PRD §13):
 *   open      -> candidate created from a low-scoring trace, awaiting review
 *   promoted  -> exported into a golden test
 *   dismissed -> reviewed and rejected as not-a-regression
 */
export type FailureCaseStatus = 'open' | 'promoted' | 'dismissed'

export interface FailureCase {
  id: string
  traceId: string
  sessionId: string
  score: number
  issues: string[]
  input: JsonValue
  output?: JsonValue
  status: FailureCaseStatus
  createdAt: string
}

export interface NewFailureCase {
  id: string
  traceId: string
  sessionId: string
  score: number
  issues?: string[]
  input: JsonValue
  output?: JsonValue
}

interface FailureCaseRow {
  id: string
  trace_id: string
  session_id: string
  score: number
  issues_json: string
  input_json: string
  output_json: string | null
  status: string
  created_at: string
}

/**
 * Converts a snake_case DB row into the camelCase FailureCase.
 */
function toFailureCase(row: FailureCaseRow): FailureCase {
  return {
    id: row.id,
    traceId: row.trace_id,
    sessionId: row.session_id,
    score: row.score,
    issues: JSON.parse(row.issues_json) as string[],
    input: JSON.parse(row.input_json) as JsonValue,
    output: row.output_json ? (JSON.parse(row.output_json) as JsonValue) : undefined,
    status: row.status as FailureCaseStatus,
    createdAt: row.created_at,
  }
}

export interface FailureCaseRepository {
  create(input: NewFailureCase): FailureCase
  findOpen(limit?: number): FailureCase[]
  markPromoted(id: string): void
}

/**
 * Creates the failure_cases repository. Failure cases are derived from low-
 * scoring traces (PRD §13 "Evaluator low score -> creates failure_case") and can
 * be promoted into golden tests.
 */
export function createFailureCaseRepository(db: Db): FailureCaseRepository {
  return {
    create(input) {
      const ts = nowIso()
      db.prepare(
        `INSERT INTO failure_cases
           (id, trace_id, session_id, score, issues_json, input_json, output_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ).run(
        input.id,
        input.traceId,
        input.sessionId,
        input.score,
        JSON.stringify(input.issues ?? []),
        JSON.stringify(input.input),
        input.output === undefined ? null : JSON.stringify(input.output),
        ts,
      )
      const row = db
        .prepare('SELECT * FROM failure_cases WHERE id = ?')
        .get(input.id) as FailureCaseRow
      return toFailureCase(row)
    },

    findOpen(limit = 100) {
      const rows = db
        .prepare('SELECT * FROM failure_cases WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all('open', limit) as FailureCaseRow[]
      return rows.map(toFailureCase)
    },

    markPromoted(id) {
      db.prepare('UPDATE failure_cases SET status = ? WHERE id = ?').run('promoted', id)
    },
  }
}

export type { JsonValue }
