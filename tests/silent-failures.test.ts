import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEvidence, recordKnowledge } from "../src/agent/lib/evidence.ts";
import {
  MAX_KNOWLEDGE_CALLS,
  allowedTools,
  renderAgentStatus,
  stageFor,
} from "../src/agent/lib/workflow.ts";
import { WorkflowStage } from "../src/agent/lib/context.ts";
import { Catalog } from "../src/data/catalog.ts";
import { DATA_DIR } from "../src/data/seed.ts";

describe("不把失败伪装成成功", () => {
  // 0 命中曾被记成「该 scope 已完成」，状态栏于是告诉模型「你已经查到了」。
  // 模型据此凭记忆写答案，一直到 finalizeReply 才因为没有依据被拒。
  it("检索 0 命中时不标记 scope 完成", () => {
    const evidence = createEvidence();

    recordKnowledge(evidence, [], [], "general");
    assert.equal(evidence.completed_knowledge_scopes.has("general"), false);
    // Tool 确实被调用过，这一点仍要如实记录。
    assert.deepStrictEqual(evidence.used_tools, ["retrieve_knowledge"]);
  });

  it("检索有命中时才标记 scope 完成", () => {
    const evidence = createEvidence();
    const hit = {
      doc_id: "D1",
      title: "退货政策",
      content: "七天无理由退货",
      category: "耳机",
      product_id: null,
      source: "policy",
      chunk_ordinal: 0,
      relevance_score: 1,
    };

    recordKnowledge(evidence, [hit], [], "general");
    assert.equal(evidence.completed_knowledge_scopes.has("general"), true);
  });

  // 用户说「一万五以上的电脑」时，上限曾被硬钉在 MAX_PRICE_CENTS，
  // 算出 min > max，search() 抛内部错误码并原样甩给用户。
  it("只说下限且超出库存价位时返回空候选，而不是抛错", () => {
    const catalog = new Catalog(":memory:", DATA_DIR);
    try {
      const profile = catalog.userProfile("user_vip", {
        preferred_categories: ["电脑"],
        min_price_cents: 1_500_000,
        max_price_cents: null,
        recent_purchases: null,
        recent_views: null,
      });

      assert.ok(
        profile.max_price_cents !== null &&
          profile.max_price_cents >= profile.min_price_cents,
        "上限不应低于下限",
      );
      const found = catalog.search({
        profile,
        categories: ["电脑"],
        minPriceCents: profile.min_price_cents,
        maxPriceCents: profile.max_price_cents,
        limit: 10,
      });
      assert.deepStrictEqual(found, []);
    } finally {
      catalog.close();
    }
  });

  // 检索三次仍 0 命中时，提示词允许模型"说明没有查到"。此前 stageFor 永远停在
  // NEED_SUPPORT，allowed_next 为空又不给 final_output——模型被告知它什么都不能做，
  // 只能撞满 maxTurns。这是提示词与 Harness 互相矛盾的死局。
  it("检索次数用尽后允许收尾，不把模型困在无事可做的状态", () => {
    const evidence = createEvidence();
    evidence.required_support_tools = ["retrieve_knowledge"];
    evidence.required_knowledge_scopes = ["general"];

    for (let i = 0; i < MAX_KNOWLEDGE_CALLS; i += 1) {
      recordKnowledge(evidence, [], [], "general");
    }

    // 一条都没命中，所以 scope 不算"查到了"。
    assert.equal(evidence.completed_knowledge_scopes.has("general"), false);
    // 但检索预算已经用完，必须让模型收尾。
    assert.equal(allowedTools(evidence).includes("retrieve_knowledge"), false);
    assert.equal(stageFor(evidence), WorkflowStage.READY_TO_DRAFT);
    assert.match(renderAgentStatus(evidence), /final_output/);
  });

  it("还有检索机会时不提前放行，避免模型没查完就下结论", () => {
    const evidence = createEvidence();
    evidence.required_support_tools = ["retrieve_knowledge"];
    evidence.required_knowledge_scopes = ["general"];

    recordKnowledge(evidence, [], [], "general");

    assert.equal(stageFor(evidence), WorkflowStage.NEED_SUPPORT);
    assert.equal(allowedTools(evidence).includes("retrieve_knowledge"), true);
  });
});
