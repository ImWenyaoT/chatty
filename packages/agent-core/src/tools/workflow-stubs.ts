import type { JsonValue, RuntimeTool } from '@rental/shared'

// Write/workflow tools. Risk follows PRD §11 Tool Safety:
//   create_handoff      -> medium (customer-facing escalation)
//   schedule_followup   -> low (PRD lists follow-up schedule as low risk)
// These are stubs that echo a deterministic receipt; real Chatwoot/scheduler
// adapters replace them behind the same interface.

/**
 * Deterministic timestamp for stub receipts so tests are reproducible.
 */
function nowIso(): string {
  return new Date('2026-06-26T00:00:00.000Z').toISOString()
}

// --- create_handoff(conversationId, reason, context) ------------------------

export const createHandoffTool: RuntimeTool<Record<string, JsonValue>, JsonValue> = {
  name: 'create_handoff',
  description: 'Hand a conversation off to a human agent with reason and context.',
  risk: 'medium',
  approvalRequired: false,
  async execute(input) {
    const conversationId = String(input.conversationId ?? '')
    const reason = String(input.reason ?? '')
    return {
      ok: true,
      handoffId: `HO-${conversationId || 'unknown'}`,
      conversationId,
      reason,
      context: input.context ?? null,
      createdAt: nowIso(),
    }
  },
}

// --- schedule_followup(conversationId, dueAt, reason) -----------------------

export const scheduleFollowupTool: RuntimeTool<Record<string, JsonValue>, JsonValue> = {
  name: 'schedule_followup',
  description: 'Schedule a follow-up touch on a conversation for a future time.',
  risk: 'low',
  approvalRequired: false,
  async execute(input) {
    const conversationId = String(input.conversationId ?? '')
    const dueAt = String(input.dueAt ?? '')
    const reason = String(input.reason ?? '')
    return {
      ok: true,
      followupId: `FU-${conversationId || 'unknown'}`,
      conversationId,
      dueAt,
      reason,
      createdAt: nowIso(),
    }
  },
}
