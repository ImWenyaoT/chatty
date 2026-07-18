import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultToolRegistry,
  ApprovalRequiredError,
  ToolNotFoundError,
} from "./registry.js";

// MVP tool set: the 3 actions the harness scheduler dispatches + the
// schema-only high-risk refund stub.
const EXPECTED_TOOLS = [
  "check_availability",
  "create_handoff",
  "schedule_followup",
  "issue_refund",
];

function registry() {
  return createDefaultToolRegistry(
    undefined,
    {
      createHandoff: (input) => ({
        ok: true,
        handoffId: "task-human",
        ...input,
      }),
      scheduleFollowup: (input) => ({
        ok: true,
        followupId: "task-time",
        ...input,
      }),
    },
    {
      checkAvailability: (input) => ({
        ...input,
        available: true,
        availableQuantity: 2,
        productName: "黑色双排扣西装",
      }),
    },
  );
}

test("default registry registers exactly the 4 MVP tools", () => {
  const names = registry()
    .list()
    .map((t) => t.name)
    .sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
});

test("check_availability answers for a known product", async () => {
  const out = await registry().invoke("check_availability", {
    productId: "SUIT-001",
    size: "L",
    startDate: "2026-08-01",
    endDate: "2026-08-03",
  });
  const r = out as {
    available: boolean;
    availableQuantity: number;
    productId: string;
  };
  assert.equal(r.available, true);
  assert.equal(r.availableQuantity, 2);
  assert.equal(r.productId, "SUIT-001");
});

test("create_handoff is low risk so the agent can always create a real work item", async () => {
  const out = await registry().invoke("create_handoff", {
    conversationId: "c:SUIT-001",
    reason: "投诉",
    context: { x: 1 },
  });
  const r = out as { ok: boolean; handoffId: string };
  assert.equal(r.ok, true);
  assert.equal(r.handoffId, "task-human");
  assert.equal(registry().get("create_handoff")?.risk, "low");
});

test("schedule_followup returns its durable adapter receipt", async () => {
  const out = await registry().invoke("schedule_followup", {
    conversationId: "c:SUIT-001",
    dueAt: "2026-06-27T00:00:00.000Z",
    reason: "物流跟进",
  });
  assert.equal((out as { followupId: string }).followupId, "task-time");
});

test("schedule_followup observes cancellation while its capability is running", async () => {
  const controller = new AbortController();
  let capabilitySignal!: AbortSignal;
  const tools = createDefaultToolRegistry(undefined, {
    scheduleFollowup: async (_input, options) => {
      assert.ok(options?.signal);
      capabilitySignal = options.signal;
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          {
            once: true,
          },
        ),
      );
      return { ok: true };
    },
  });
  const execution = tools.invoke(
    "schedule_followup",
    {
      conversationId: "cancel-tool",
      dueAt: "2026-07-12T00:00:00.000Z",
      reason: "test",
    },
    { signal: controller.signal },
  );
  while (!capabilitySignal)
    await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("workflow cancelled"));
  await assert.rejects(execution, /workflow cancelled/);
  assert.equal(capabilitySignal, controller.signal);
});

test("issue_refund is high risk + approvalRequired => invoke throws ApprovalRequiredError", async () => {
  await assert.rejects(
    () =>
      registry().invoke("issue_refund", {
        orderNo: "ORD-1001",
        amount: 100,
        reason: "破损",
      }),
    (err: unknown) => err instanceof ApprovalRequiredError,
  );
});

test("invoke on unknown tool throws ToolNotFoundError", async () => {
  await assert.rejects(
    () => registry().invoke("does_not_exist", {}),
    (err: unknown) => err instanceof ToolNotFoundError,
  );
});

test("issue_refund risk is high and approvalRequired is true", () => {
  const t = registry().get("issue_refund");
  assert.equal(t?.risk, "high");
  assert.equal(t?.approvalRequired, true);
});
