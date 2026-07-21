import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactApprovalSchema,
  ArtifactListSchema,
  RunRequestSchema,
  RunResponseSchema,
} from "../src/index.js";

const respondedRun = {
  reply: "你好",
  customer_id: "demo-customer",
  session_id: "session-1",
  trace_id: "trace-1",
  request_id: "request-1",
  status: "responded",
  business_outcome: "not_applicable",
  completion_evidence: null,
  knowledge_search_results: [],
  memory_events: [],
  needs_human: false,
  support_request_id: null,
};

test("run request keeps legacy limits and strips untrusted extra fields", () => {
  assert.equal(RunRequestSchema.safeParse({ message: "hi" }).success, true);
  assert.equal(RunRequestSchema.safeParse({ message: "" }).success, false);
  assert.deepEqual(
    RunRequestSchema.parse({ message: "hi", customer_id: "untrusted" }),
    { message: "hi" },
  );
});

test("run response preserves completion and handoff invariants", () => {
  assert.equal(RunResponseSchema.safeParse(respondedRun).success, true);
  assert.equal(
    RunResponseSchema.safeParse({
      ...respondedRun,
      status: "completed",
      business_outcome: "verified",
      completion_evidence: null,
    }).success,
    false,
  );
  assert.equal(
    RunResponseSchema.safeParse({
      ...respondedRun,
      status: "needs_human",
      business_outcome: "not_completed",
      completion_evidence: "handoff:support-1",
      needs_human: true,
      support_request_id: "support-1",
    }).success,
    true,
  );
});

test("artifact contracts expose review state without granting Model approval", () => {
  const parsed = ArtifactListSchema.parse([
    {
      id: "artifact-1",
      kind: "content",
      owner_id: "trusted-owner",
      session_id: "session-1",
      title: "高精地图内容包",
      status: "review_pending",
      created_at: "2026-07-21T00:00:00.000Z",
      updated_at: "2026-07-21T00:00:00.000Z",
      research_artifact_id: "artifact-research",
      channels: [
        {
          channel: "xiaohongshu",
          title: "高精地图如何支持智能驾驶",
          body: "演示内容",
          claim_ids: ["claim-position"],
        },
      ],
    },
  ]);
  assert.equal(parsed[0]?.kind, "content");
  assert.equal(
    ArtifactApprovalSchema.safeParse({
      id: "approval-1",
      artifact_id: "artifact-1",
      actor_id: "trusted-reviewer",
      decision: "approved",
      created_at: "2026-07-21T00:00:01.000Z",
    }).success,
    true,
  );
  assert.equal(
    ArtifactListSchema.safeParse([
      { ...parsed[0], channels: [{ channel: "real-platform" }] },
    ]).success,
    false,
  );
});
