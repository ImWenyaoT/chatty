import type { JsonValue, RuntimeTool } from "@rental/shared";

// Write/workflow tools. Risk follows PRD §11 Tool Safety:
//   create_handoff      -> low (creates a traceable work item; it does not resolve the dispute)
//   schedule_followup   -> low (PRD lists follow-up schedule as low risk)
// A workflow tool exists only when the application supplies a real durable
// adapter. The Harness must never manufacture a successful side-effect receipt.

// --- create_handoff(conversationId, reason, context) ------------------------

export function createHandoffTool(
  create: (
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
      return create(input, options);
    },
  };
}

// --- schedule_followup(conversationId, dueAt, reason) -----------------------

/** Builds the follow-up capability around a durable scheduler when one is available. */
export function createScheduleFollowupTool(
  schedule: (
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
      return schedule(input, options);
    },
  };
}
