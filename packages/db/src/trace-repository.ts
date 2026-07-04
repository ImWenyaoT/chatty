import type { AgentTrace, ConversationEventType, JsonValue, RuntimeToolCall } from '@rental/shared'
import type { Db } from './database.js'
import { nowIso } from './database.js'

/**
 * Append-only store for agent traces. Each bounded step appends one row
 * capturing intent, action, input/output, tool calls and references, so a human
 * agent can later inspect why the bot replied (PRD §6.5 user story).
 */
export interface TraceRepository {
  append(input: NewTrace): AgentTrace
  queryBySession(sessionId: string, limit?: number): AgentTrace[]
  /** Traces that have no trace_reviews row yet, newest-first. Drives the eval loop (PRD §10). */
  findUnevaluated(limit?: number): AgentTrace[]
}

export interface NewTrace {
  id: string
  sessionId: string
  eventType: ConversationEventType
  intent?: string
  action?: string
  input: JsonValue
  output?: JsonValue
  toolCalls?: RuntimeToolCall[]
  references?: JsonValue[]
}

interface TraceRow {
  id: string
  session_id: string
  event_type: string
  intent: string | null
  action: string | null
  input_json: string
  output_json: string | null
  tool_calls_json: string
  references_json: string
  created_at: string
}

export function createTraceRepository(db: Db): TraceRepository {
  const toTrace = (row: TraceRow): AgentTrace => ({
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type as ConversationEventType,
    intent: row.intent ?? undefined,
    action: row.action ?? undefined,
    input: JSON.parse(row.input_json) as JsonValue,
    output: row.output_json ? (JSON.parse(row.output_json) as JsonValue) : undefined,
    toolCalls: JSON.parse(row.tool_calls_json) as RuntimeToolCall[],
    references: JSON.parse(row.references_json) as JsonValue[],
    createdAt: row.created_at,
  })

  return {
    append(input) {
      const ts = nowIso()
      const toolCalls = input.toolCalls ?? []
      const references = input.references ?? []
      db.prepare(
        `INSERT INTO agent_traces (id, session_id, event_type, intent, action, input_json, output_json, tool_calls_json, references_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.sessionId,
        input.eventType,
        input.intent ?? null,
        input.action ?? null,
        JSON.stringify(input.input),
        input.output === undefined ? null : JSON.stringify(input.output),
        JSON.stringify(toolCalls),
        JSON.stringify(references),
        ts,
      )
      // Construct the inserted row directly instead of re-querying the session
      // (which read the newest 100 and could miss this row on a created_at tie).
      return {
        id: input.id,
        sessionId: input.sessionId,
        eventType: input.eventType,
        intent: input.intent,
        action: input.action,
        input: input.input,
        output: input.output,
        toolCalls,
        references,
        createdAt: ts,
      }
    },

    queryBySession(sessionId, limit = 100) {
      const rows = db
        .prepare(`SELECT * FROM agent_traces WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(sessionId, limit) as TraceRow[]
      // newest-first from DB; return oldest-first for chronological reading.
      return rows.reverse().map(toTrace)
    },

    findUnevaluated(limit = 100) {
      const rows = db
        .prepare(
          `SELECT t.* FROM agent_traces t
           WHERE NOT EXISTS (SELECT 1 FROM trace_reviews r WHERE r.trace_id = t.id)
           ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`,
        )
        .all(limit) as TraceRow[]
      // newest-first is the natural eval queue order (process recent first).
      return rows.map(toTrace)
    },
  }
}
