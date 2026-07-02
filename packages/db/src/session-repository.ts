import type { AgentSession, AgentSessionStatus, JsonValue } from '@rental/shared'
import type { Db } from './database.js'
import { nowIso } from './database.js'

/**
 * Repository for the `agent_sessions` table: one row per Chatty session.
 * Keeps the column model thin (docs §6.1) and defers rich state to memory.
 */
export interface SessionRepository {
  get(id: string): AgentSession | undefined
  findByConversation(conversationId: string): AgentSession | undefined
  create(input: NewSession): AgentSession
  update(id: string, patch: SessionPatch): AgentSession | undefined
}

export interface NewSession {
  id: string
  customerId: string
  conversationId: string
  productId?: string
  currentStep?: string
}

export interface SessionPatch {
  status?: AgentSessionStatus
  currentStep?: string
  productId?: string
}

interface SessionRow {
  id: string
  customer_id: string
  product_id: string | null
  conversation_id: string
  status: string
  current_step: string
  created_at: string
  updated_at: string
}

export function createSessionRepository(db: Db): SessionRepository {
  const toSession = (row: SessionRow): AgentSession => ({
    id: row.id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    productId: row.product_id ?? undefined,
    status: row.status as AgentSessionStatus,
    currentStep: row.current_step,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  return {
    get(id) {
      const row = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
        | SessionRow
        | undefined
      return row ? toSession(row) : undefined
    },

    findByConversation(conversationId) {
      const row = db
        .prepare(
          'SELECT * FROM agent_sessions WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1',
        )
        .get(conversationId) as SessionRow | undefined
      return row ? toSession(row) : undefined
    },

    create(input) {
      const ts = nowIso()
      db.prepare(
        `INSERT INTO agent_sessions (id, customer_id, product_id, conversation_id, status, current_step, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.customerId,
        input.productId ?? null,
        input.conversationId,
        'active',
        input.currentStep ?? 'init',
        ts,
        ts,
      )
      return this.get(input.id)!
    },

    update(id, patch) {
      const existing = this.get(id)
      if (!existing) return undefined
      const ts = nowIso()
      db.prepare(
        `UPDATE agent_sessions
         SET status = ?, current_step = ?, product_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        patch.status ?? existing.status,
        patch.currentStep ?? existing.currentStep,
        patch.productId ?? existing.productId ?? null,
        ts,
        id,
      )
      return this.get(id)
    },
  }
}

// Re-export so callers don't need @rental/shared just for JsonValue typing.
export type { JsonValue }
