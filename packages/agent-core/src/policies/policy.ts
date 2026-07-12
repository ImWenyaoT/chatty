import type { RuntimeToolCall, RuntimeToolRisk } from "@rental/shared";

/**
 * Policy decision for a candidate tool call. allow = run now; require_approval
 * = pause and surface to an operator; deny = refuse outright.
 */
export type PolicyDecision =
  | { action: "allow" }
  | { action: "require_approval"; reason: string }
  | { action: "deny"; reason: string };

/**
 * Runtime context the policy may consult. Kept minimal in MVP (session status
 * only); extensible with customer tier, open disputes, SLA, etc. later.
 */
export interface PolicyContext {
  sessionStatus:
    | "active"
    | "waiting_for_user"
    | "waiting_for_tool"
    | "waiting_for_human"
    | "paused"
    | "closed"
    | "failed";
  customerId?: string;
  conversationId?: string;
}

/** A strategy that classifies a tool call against the safety policy. */
export interface Policy {
  check(toolCall: RuntimeToolCall, context: PolicyContext): PolicyDecision;
}

/**
 * Default composite policy (PRD §11 Tool Safety):
 *   low risk           -> allow (read-only, internal note, follow-up)
 *   medium risk        -> require_approval (customer-facing reply/handoff)
 *   high risk          -> require_approval (refund/compensation)
 *   closed session     -> deny (no new side effects after close)
 */
export function createDefaultPolicy(): Policy {
  return {
    check(toolCall, context) {
      if (context.sessionStatus === "closed") {
        return { action: "deny", reason: "session closed" };
      }
      const risk: RuntimeToolRisk = toolCall.risk;
      if (risk === "low") return { action: "allow" };
      return { action: "require_approval", reason: `risk=${risk}` };
    },
  };
}
