import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStateError, ArtifactStore } from "../src/artifacts.js";

test("reviewed research artifact requires trusted approval before one sandbox delivery", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-artifacts-"));
  const store = new ArtifactStore(join(directory, "chatty.sqlite"));
  try {
    const artifact = store.createResearch({
      idempotency_key: "research-run-1",
      owner_id: "trusted-operator",
      session_id: "session-1",
      title: "高精地图产业研究简报",
      summary: "基于本地演示资料整理产业位置与增长变量。",
      claims: [
        {
          id: "claim-position",
          text: "高精地图连接定位数据、地图更新与智能驾驶应用。",
          source_ids: ["demo-industry-map"],
        },
      ],
      nodes: [
        { id: "mapping", label: "高精地图", kind: "product" },
        { id: "autonomy", label: "智能驾驶", kind: "application" },
      ],
      relations: [
        {
          from: "mapping",
          to: "autonomy",
          type: "supports",
          claim_id: "claim-position",
        },
      ],
      unknowns: ["演示数据不包含实时市场规模"],
    });

    assert.equal(artifact.status, "draft");
    assert.throws(
      () => store.export(artifact.id, "sandbox", "trusted-operator"),
      (error: unknown) =>
        error instanceof ArtifactStateError &&
        error.code === "artifact_not_approved",
    );

    const review = store.review(artifact.id);
    assert.equal(review.passed, true);
    assert.deepEqual(review.errors, []);
    assert.equal(store.get(artifact.id).status, "review_pending");

    const approval = store.approve(
      artifact.id,
      "trusted-reviewer",
      "trusted-operator",
    );
    assert.equal(approval.decision, "approved");
    assert.equal(approval.actor_id, "trusted-reviewer");
    assert.equal(store.get(artifact.id).status, "approved");

    assert.throws(
      () => store.export(artifact.id, "sandbox", "another-owner"),
      /artifact_/,
    );
    const first = store.export(artifact.id, "sandbox", "trusted-operator");
    const replay = store.export(artifact.id, "sandbox", "trusted-operator");
    assert.deepEqual(replay, first);
    assert.equal(first.target, "sandbox");
    assert.match(first.id, /^delivery_/);
    assert.equal(store.get(artifact.id).status, "exported");
  } finally {
    store.close();
  }
});

test("content artifact review rejects claims outside its reviewed research parent", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-artifacts-"));
  const store = new ArtifactStore(join(directory, "chatty.sqlite"));
  try {
    const research = store.createResearch({
      idempotency_key: "research-for-content",
      owner_id: "trusted-operator",
      session_id: "session-2",
      title: "智能驾驶产业简报",
      summary: "只包含本地演示资料支持的结论。",
      claims: [
        {
          id: "claim-grounded",
          text: "高精地图是演示产业链中的数据基础能力。",
          source_ids: ["demo-industry-map"],
        },
      ],
      nodes: [],
      relations: [],
      unknowns: [],
    });
    assert.equal(store.review(research.id).passed, true);

    const content = store.createContent({
      idempotency_key: "content-run-1",
      owner_id: "trusted-operator",
      session_id: "session-2",
      research_artifact_id: research.id,
      title: "智能驾驶内容包",
      channels: [
        {
          channel: "xiaohongshu",
          title: "高精地图如何支持智能驾驶",
          body: "从数据基础能力开始理解产业链。",
          claim_ids: ["claim-grounded"],
        },
      ],
    });
    assert.equal(store.review(content.id).passed, true);

    const unsupported = store.createContent({
      idempotency_key: "content-run-2",
      owner_id: "trusted-operator",
      session_id: "session-2",
      research_artifact_id: research.id,
      title: "包含无来源卖点的内容包",
      channels: [
        {
          channel: "douyin",
          title: "市场第一",
          body: "演示资料没有支持这一卖点。",
          claim_ids: ["claim-not-found"],
        },
      ],
    });
    const review = store.review(unsupported.id);
    assert.equal(review.passed, false);
    assert.deepEqual(review.errors, [
      "content_claim_not_in_research:claim-not-found",
    ]);
    assert.equal(store.get(unsupported.id).status, "review_failed");
  } finally {
    store.close();
  }
});

test("review replay never downgrades an approved or exported artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-artifacts-"));
  const store = new ArtifactStore(join(directory, "chatty.sqlite"));
  try {
    const artifact = store.createResearch({
      idempotency_key: "stable-review",
      owner_id: "trusted-operator",
      session_id: "session-review",
      title: "稳定状态研究",
      summary: "验证状态机单调性。",
      claims: [
        {
          id: "claim-stable",
          text: "该结论有本地演示来源。",
          source_ids: ["demo-source"],
        },
      ],
      nodes: [],
      relations: [],
      unknowns: [],
    });
    const initialReview = store.review(artifact.id);
    store.approve(artifact.id, "trusted-reviewer", "trusted-operator");

    assert.deepEqual(store.review(artifact.id), initialReview);
    assert.equal(store.get(artifact.id).status, "approved");

    store.export(artifact.id, "sandbox", "trusted-operator");
    assert.deepEqual(store.review(artifact.id), initialReview);
    assert.equal(store.get(artifact.id).status, "exported");
  } finally {
    store.close();
  }
});

test("artifact idempotency rejects changed identity or payload", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-artifacts-"));
  const store = new ArtifactStore(join(directory, "chatty.sqlite"));
  const input = {
    idempotency_key: "research-idempotency",
    owner_id: "trusted-operator",
    session_id: "session-idempotency",
    title: "幂等研究",
    summary: "原始摘要。",
    claims: [
      {
        id: "claim-original",
        text: "原始结论。",
        source_ids: ["demo-source"],
      },
    ],
    nodes: [],
    relations: [],
    unknowns: [],
  };
  try {
    const first = store.createResearch(input);
    assert.equal(store.createResearch(input).id, first.id);

    for (const changed of [
      { ...input, owner_id: "another-owner" },
      { ...input, summary: "被替换的摘要。" },
    ]) {
      assert.throws(
        () => store.createResearch(changed),
        (error: unknown) =>
          error instanceof ArtifactStateError &&
          error.code === "artifact_idempotency_conflict",
      );
    }
  } finally {
    store.close();
  }
});
