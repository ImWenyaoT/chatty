/**
 * 数据层回归基线。
 *
 * `fixtures/golden/data-layer.cases.json` 的预期输出最初由 Python 实现生成并冻结，
 * 迁移时用来判定两套实现等价。Python 移除后它仍然是商品排序、分词、
 * 检索表达式这些易碎行为的回归防线，改动它等于改变 Chatty 的对外行为。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TaskFrameParseError,
  describeTaskFrame,
  parseTaskFrame,
  productContext,
} from "../src/agent/lib/framing.ts";
import { taskFrameWireSchema } from "../src/agent/subagents/task_framer/agent.ts";
import {
  createEvidence,
  validateToolSequence,
  type RecommendationEvidence,
} from "../src/agent/lib/evidence.ts";
import {
  allowedTools,
  planToolBatch,
  renderAgentStatus,
} from "../src/agent/lib/workflow.ts";
import { Catalog, CatalogError } from "../src/data/catalog.ts";
import { segmentForIndex, splitIntoChunks } from "../src/data/database.ts";
import { DATA_DIR } from "../src/data/seed.ts";
import {
  productNeedSchema,
  recommendationDraftItemSchema,
  recommendationRequestSchema,
  userContextSchema,
} from "../src/data/models.ts";
import {
  caseKey,
  loadCases,
  loadExpected,
  type GoldenCase,
} from "./helpers/golden.ts";

/** 把 JSON 里的 evidence 规格还原成 Harness 使用的可变 Evidence。 */
function buildEvidence(spec: Record<string, unknown>): RecommendationEvidence {
  const evidence = createEvidence();
  evidence.used_tools = [
    ...((spec["used_tools"] as string[] | undefined) ?? []),
  ];
  evidence.blocked_attempts = [
    ...((spec["blocked_attempts"] as string[] | undefined) ?? []),
  ];
  evidence.completed_knowledge_scopes = new Set(
    (spec["completed_knowledge_scopes"] as string[] | undefined) ?? [],
  );
  evidence.required_knowledge_scopes = [
    ...((spec["required_knowledge_scopes"] as string[] | undefined) ?? []),
  ];
  if ("required_support_tools" in spec) {
    evidence.required_support_tools = [
      ...(spec["required_support_tools"] as string[]),
    ];
  }
  evidence.allowed_final_actions = [
    ...((spec["allowed_final_actions"] as string[] | undefined) ?? []),
  ];
  return evidence;
}

// 用例字段的形状由 golden JSON 自身保证，这里放宽索引类型，避免为每个 op 重复声明。
type CaseInput = Record<string, any>;

function run(goldenCase: GoldenCase, catalog: Catalog): unknown {
  const data = goldenCase.input as CaseInput;

  switch (goldenCase.op) {
    case "segment_for_index":
      return segmentForIndex(data["text"]);
    case "split_into_chunks":
      return splitIntoChunks(data["text"], data["target"], data["overlap"]);
    case "rewrite_query":
      return catalog.rewriteQueryForGolden(data["query"]);
    case "match_expression":
      return Catalog.matchExpressionForGolden(data["query"]);

    case "user_profile":
      return catalog.userProfile(
        data["user_id"],
        userContextSchema.parse(data["overrides"]),
      );
    case "search": {
      const profile = catalog.userProfile(
        data["user_id"],
        userContextSchema.parse(data["overrides"]),
      );
      const products = catalog.search({
        profile,
        categories: data["categories"],
        minPriceCents: profile.min_price_cents,
        maxPriceCents: profile.max_price_cents,
        limit: data["limit"],
      });
      return products.map((product) => product.product_id);
    }
    case "score": {
      const profile = catalog.userProfile(data["user_id"]);
      const byId = new Map(
        catalog.products.map((product) => [product.product_id, product]),
      );
      return Object.fromEntries(
        (data["product_ids"] as string[]).map((productId) => [
          productId,
          catalog.scoreForGolden(byId.get(productId)!, profile),
        ]),
      );
    }
    case "inventory":
      return catalog
        .inventory(data["product_ids"])
        .map((product) => product.product_id);
    case "retrieve_knowledge":
      return catalog
        .retrieveKnowledge({
          query: data["query"],
          categories: data["categories"],
          productIds: data["product_ids"],
          limit: data["limit"],
        })
        .map((hit) => ({
          doc_id: hit.doc_id,
          chunk_ordinal: hit.chunk_ordinal,
          category: hit.category,
          product_id: hit.product_id,
          relevance_score: hit.relevance_score,
        }));
    case "marketing_strategy":
      return Object.fromEntries(
        (data["segments"] as string[]).map((segment) => [
          segment,
          catalog.marketingStrategy(segment),
        ]),
      );
    case "finalize": {
      const context = userContextSchema.parse(data["overrides"]);
      const request = recommendationRequestSchema.parse({
        user_id: data["user_id"],
        num_items: data["num_items"],
        context,
      });
      const profile = catalog.userProfile(request.user_id, context);
      const draft = (data["draft"] as unknown[]).map((item) =>
        recommendationDraftItemSchema.parse(item),
      );
      return catalog.finalize(draft, request, profile);
    }

    case "parse_task_frame":
      return parseTaskFrame(
        taskFrameWireSchema.parse(data["wire"]),
        catalog.categories,
      );
    case "product_context":
      return productContext(productNeedSchema.parse(data["need"]));
    case "describe_task_frame": {
      const frame = data["frame"] as {
        product_need: unknown;
        knowledge_query: string | null;
      };
      return describeTaskFrame({
        product_need:
          frame.product_need === null
            ? null
            : productNeedSchema.parse(frame.product_need),
        knowledge_query: frame.knowledge_query,
      });
    }

    case "validate_tool_sequence":
      return validateToolSequence(data["used_tools"]);
    case "workflow_state": {
      const evidence = buildEvidence(data["evidence"]);
      return {
        allowed_next: allowedTools(evidence),
        agent_status: renderAgentStatus(evidence),
      };
    }
    case "plan_tool_batch": {
      const evidence = buildEvidence(data["evidence"]);
      const calls = (data["calls"] as [string, string][]).map(
        ([callId, name]) => [callId, name] as const,
      );
      const batch = planToolBatch(evidence, calls);
      return {
        stage: batch.stage,
        decisions: Object.fromEntries(batch.decisions),
      };
    }

    default:
      throw new Error(`unknown golden op: ${goldenCase.op}`);
  }
}

/** 只有业务错误折叠成 `{error}`，其它异常直接失败。 */
function outcome(goldenCase: GoldenCase, catalog: Catalog): unknown {
  try {
    return { ok: run(goldenCase, catalog) };
  } catch (error) {
    if (error instanceof CatalogError || error instanceof TaskFrameParseError) {
      return { error: error.message };
    }
    throw error;
  }
}

describe("golden 基线", () => {
  it("case 与 expected 一一对应", () => {
    const cases = loadCases();
    const expected = loadExpected();

    assert.ok(cases.length > 0);
    assert.deepStrictEqual(
      cases.map(caseKey).sort(),
      Object.keys(expected).sort(),
    );
  });

  it("数据层输出与 golden 基线一致", () => {
    const cases = loadCases();
    const expected = loadExpected();
    const catalog = new Catalog(":memory:", DATA_DIR);

    try {
      // 逐条断言而不是整体比较，失败时能直接看到是哪个 case 漂移了。
      for (const goldenCase of cases) {
        const key = caseKey(goldenCase);
        // 先过一遍 JSON，把 undefined 字段与 Map 归一成与基线相同的形状。
        const actual: unknown = JSON.parse(
          JSON.stringify(outcome(goldenCase, catalog)),
        );
        assert.deepStrictEqual(actual, expected[key], key);
      }
    } finally {
      catalog.close();
    }
  });
});
