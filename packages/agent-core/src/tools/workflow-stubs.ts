import type { JsonValue, RuntimeTool } from "@rental/shared";

// Write/workflow tools. Risk follows PRD §11 Tool Safety:
//   create_handoff      -> low (creates a traceable work item; it does not resolve the dispute)
//   schedule_followup   -> low (PRD lists follow-up schedule as low risk)
// These are stubs that echo a deterministic receipt; real Chatwoot/scheduler
// adapters replace them behind the same interface.

/**
 * Deterministic timestamp for stub receipts so tests are reproducible.
 */
function nowIso(): string {
  return new Date("2026-06-26T00:00:00.000Z").toISOString();
}

// --- create_handoff(conversationId, reason, context) ------------------------

export function createHandoffTool(
  create?: (
    input: Record<string, JsonValue>,
    options?: { signal?: AbortSignal },
  ) => Promise<JsonValue> | JsonValue,
): RuntimeTool<Record<string, JsonValue>, JsonValue> {
  return {
    name: "create_handoff",
    description:
      "Hand a conversation off to a human agent with reason and context.",
    risk: "low",
    approvalRequired: false,
    async execute(input, options) {
      if (create) return create(input, options);
      const conversationId = String(input.conversationId ?? "");
      const reason = String(input.reason ?? "");
      return {
        ok: true,
        handoffId: `HO-${conversationId || "unknown"}`,
        conversationId,
        reason,
        context: input.context ?? null,
        createdAt: nowIso(),
      };
    },
  };
}

// --- schedule_followup(conversationId, dueAt, reason) -----------------------

/** Builds the follow-up capability around a durable scheduler when one is available. */
export function createScheduleFollowupTool(
  schedule?: (
    input: Record<string, JsonValue>,
    options?: { signal?: AbortSignal },
  ) => Promise<JsonValue> | JsonValue,
): RuntimeTool<Record<string, JsonValue>, JsonValue> {
  return {
    name: "schedule_followup",
    description:
      "Schedule a follow-up touch on a conversation for a future time.",
    risk: "low",
    approvalRequired: false,
    async execute(input, options) {
      if (schedule) return schedule(input, options);
      const conversationId = String(input.conversationId ?? "");
      const dueAt = String(input.dueAt ?? "");
      const reason = String(input.reason ?? "");
      return {
        ok: true,
        followupId: `FU-${conversationId || "unknown"}`,
        conversationId,
        dueAt,
        reason,
        createdAt: nowIso(),
      };
    },
  };
}
