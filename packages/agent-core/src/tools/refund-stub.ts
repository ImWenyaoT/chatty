import type { JsonValue, RuntimeTool } from "@rental/shared";

// High-risk tools (PRD §11: refund/compensation/order modification). These are
// schema-only this round: approvalRequired is true so they can never auto-run,
// and execute() intentionally throws until a real finance adapter exists.

/**
 * Thrown by high-risk stubs whose execution is intentionally deferred. The
 * approvalRequired gate (plus policy) prevents this from ever firing in an
 * auto-run path; it exists as an explicit guardrail.
 */
export class NotImplementedError extends Error {
  constructor(name: string) {
    super(`tool not implemented this round: ${name}`);
    this.name = "NotImplementedError";
  }
}

/**
 * Builds an execute() that always throws NotImplementedError. Used so the
 * high-risk tool is structurally complete but cannot perform side effects.
 */
function notImplemented(name: string) {
  return async (): Promise<JsonValue> => {
    throw new NotImplementedError(name);
  };
}

// --- issue_refund(orderNo, amount, reason) ----------------------------------
// approvalRequired:true + high risk => always needs human approval (PRD §11).

export const issueRefundTool: RuntimeTool<
  Record<string, JsonValue>,
  JsonValue
> = {
  name: "issue_refund",
  description:
    "Issue a refund/compensation on an order. Requires human approval.",
  risk: "high",
  approvalRequired: true,
  execute: notImplemented("issue_refund"),
};
