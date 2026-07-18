import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultPolicy } from "./policy.js";
import {
  createDefaultToolRegistry,
  ApprovalRequiredError,
  PolicyDenyError,
  ToolRegistry,
} from "../tools/registry.js";
import type { RuntimeToolCall } from "@rental/shared";

const policy = createDefaultPolicy();

/**
 * Builds a RuntimeToolCall descriptor for policy assertions.
 */
function call(
  name: string,
  risk: "low" | "medium" | "high",
  approvalRequired = false,
): RuntimeToolCall {
  return { toolName: name, arguments: {}, risk, approvalRequired };
}

test("low risk tool => allow", () => {
  const d = policy.check(call("schedule_followup", "low"), {
    sessionStatus: "active",
  });
  assert.deepEqual(d, { action: "allow" });
});

test("medium risk tool => require_approval", () => {
  const d = policy.check(call("create_handoff", "medium"), {
    sessionStatus: "active",
  });
  assert.equal(d.action, "require_approval");
});

test("high risk tool => require_approval", () => {
  const d = policy.check(call("issue_refund", "high", true), {
    sessionStatus: "active",
  });
  assert.equal(d.action, "require_approval");
});

test("closed session => deny regardless of risk", () => {
  const d = policy.check(call("schedule_followup", "low"), {
    sessionStatus: "closed",
  });
  assert.equal(d.action, "deny");
});

test("invokeWithPolicy allows low-risk tool to execute", async () => {
  const out = await createDefaultToolRegistry(undefined, {
    scheduleFollowup: () => ({ ok: true }),
  }).invokeWithPolicy(
    "schedule_followup",
    { conversationId: "c:SUIT-001", dueAt: "next_business_day", reason: "x" },
    policy,
    { sessionStatus: "active" },
  );
  assert.equal((out as { ok: boolean }).ok, true);
});

test("invokeWithPolicy throws ApprovalRequiredError for medium-risk tool", async () => {
  const tools = new ToolRegistry().register({
    name: "send_compensation_offer",
    description: "Send a customer-facing compensation offer",
    risk: "medium",
    approvalRequired: false,
    async execute() {
      return { ok: true };
    },
  });
  await assert.rejects(
    () =>
      tools.invokeWithPolicy(
        "send_compensation_offer",
        { reason: "x" },
        policy,
        { sessionStatus: "active" },
      ),
    (err: unknown) => err instanceof ApprovalRequiredError,
  );
});

test("invokeWithPolicy throws PolicyDenyError on closed session", async () => {
  await assert.rejects(
    () =>
      createDefaultToolRegistry(undefined, {
        scheduleFollowup: () => ({ ok: true }),
      }).invokeWithPolicy(
        "schedule_followup",
        {
          conversationId: "c:SUIT-001",
          dueAt: "next_business_day",
          reason: "x",
        },
        policy,
        { sessionStatus: "closed" },
      ),
    (err: unknown) => err instanceof PolicyDenyError,
  );
});
