import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  KnowledgeReply,
  Product,
  RecommendationResponse,
} from "../src/data/models.ts";
import { answerContains, caseSucceeds, type AgentCase } from "../src/evals/agent.ts";
import {
  evaluateRetrieval,
  runRetrievalEval,
  type KnowledgeSource,
} from "../src/evals/retrieval.ts";
import { Catalog } from "../src/data/catalog.ts";
import { DATA_DIR } from "../src/paths.ts";

const emptySource: KnowledgeSource = { retrieveKnowledge: () => [] };

describe("离线评测", () => {
  it("命中率回退时退出码非 0", (t) => {
    t.mock.method(console, "log", () => undefined);

    assert.equal(runRetrievalEval(emptySource), 1);
    assert.deepStrictEqual(evaluateRetrieval(emptySource), {
      cases: 10,
      hit_rate_at_5: 0,
      mrr_at_5: 0,
    });
  });

  it("真实语料上的检索全部命中", () => {
    const catalog = new Catalog(":memory:", DATA_DIR);
    try {
      const metrics = evaluateRetrieval(catalog);
      assert.equal(metrics.cases, 10);
      assert.equal(metrics.hit_rate_at_5, 1);
      assert.ok(metrics.mrr_at_5 > 0.5);
    } finally {
      catalog.close();
    }
  });

  it("知识回答缺少事实要点时判失败", () => {
    const reply: KnowledgeReply = { kind: "answer", answer: "请查看帮助中心。" };

    assert.equal(answerContains(reply, ["合作快递", "订单"]), false);
    assert.equal(answerContains(reply, []), true);
  });

  it("空推荐不算成功", () => {
    const testCase: AgentCase = {
      name: "empty recommendation",
      userId: "user_budget",
      userText: "推荐耳机",
      expectedAction: "recommend",
    };
    const reply: RecommendationResponse = {
      kind: "recommend",
      products: [],
      answer: null,
    };

    assert.equal(caseSucceeds(testCase, reply, new Map<string, Product>()), false);
  });
});
