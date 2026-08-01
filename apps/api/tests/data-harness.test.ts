import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Catalog, CatalogError } from "../src/catalog.js";
import { DATA_DIR } from "../src/config.js";
import { segmentForIndex, splitIntoChunks } from "../src/database.js";
import {
  EvidenceError,
  createEvidence,
  recordInventory,
  recordKnowledge,
  recordSearch,
  snapshotEvidence,
  validateRecommendationEvidence,
  validateToolSequence,
} from "../src/tools.js";

const roots: string[] = [];
const createCatalog = (): Catalog => {
  const root = mkdtempSync(join(tmpdir(), "chatty-data-"));
  roots.push(root);
  return new Catalog({
    databasePath: join(root, "chatty.db"),
    dataDir: DATA_DIR,
  });
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("SQLite 数据投影与 FTS5", () => {
  it("按中文字符建索引，并在句子边界切块", () => {
    expect(segmentForIndex("降噪 iPhone")).toBe(" 降  噪  iPhone");
    expect(splitIntoChunks("第一句。第二句。第三句。", 8, 0)).toEqual([
      "第一句。第二句。",
      "第三句。",
    ]);
  });

  it("用 FTS5/BM25 召回命中的原文块", () => {
    const catalog = createCatalog();
    try {
      const hits = catalog.retrieveKnowledge({
        query: "降噪 耳机 通勤",
        categories: ["耳机"],
        product_ids: [],
        limit: 3,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.content).toContain("降噪");
      expect(hits[0]?.content).not.toMatch(/ 降  噪 /u);
      expect(hits[0]?.relevance_score).toBeGreaterThan(0);
    } finally {
      catalog.close();
    }
  });

  it("长商品名不会挤掉 Harness 已知的类目检索词", () => {
    const catalog = createCatalog();
    try {
      const hits = catalog.retrieveKnowledge({
        query: "小米 Redmi Buds 6 无线耳机 性价比 入门",
        categories: ["耳机"],
        product_ids: ["P023"],
        limit: 5,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.category === "耳机")).toBe(true);
    } finally {
      catalog.close();
    }
  });
});

describe("Catalog 是商品事实的唯一 seam", () => {
  it("本轮单边价格约束不会继承冲突的历史画像区间", () => {
    const catalog = createCatalog();
    try {
      expect(
        catalog.userProfile("user_active", { max_price_cents: 30_000 }),
      ).toMatchObject({ min_price_cents: 0, max_price_cents: 30_000 });
      expect(
        catalog.userProfile("user_budget", { min_price_cents: 200_000 }),
      ).toMatchObject({
        min_price_cents: 200_000,
        max_price_cents: 1_000_000,
      });
    } finally {
      catalog.close();
    }
  });

  it("搜索按画像排序，库存去重并排除售罄", () => {
    const catalog = createCatalog();
    try {
      const profile = catalog.userProfile("user_budget");
      const ranked = catalog.search({
        profile,
        categories: [],
        min_price_cents: 0,
        max_price_cents: 1_000_000,
        tags: [],
        limit: 5,
      });
      expect(ranked[0]?.category).toBe("配件");
      expect(
        catalog
          .inventory(["P015", "P003", "P003"])
          .map((item) => item.product_id),
      ).toEqual(["P003"]);
    } finally {
      catalog.close();
    }
  });

  it("finalize 用 SQLite 真值覆盖模型字段、过滤禁词并在成功后更新画像", () => {
    const catalog = createCatalog();
    try {
      const request = {
        user_id: "user_active",
        num_items: 1,
        context: { preferred_categories: ["耳机"] },
      };
      const profile = catalog.userProfile(request.user_id, request.context);
      const [result] = catalog.finalize(
        [
          {
            product_id: "P003",
            reason: "这是最好的选择",
            marketing_copy: "100%最好",
          },
        ],
        request,
        profile,
      );
      const truth = catalog.products.find((item) => item.product_id === "P003");
      expect(result?.price_cents).toBe(truth?.price_cents);
      expect(result?.stock).toBe(1000);
      expect(`${result?.reason}${result?.marketing_copy}`).not.toContain(
        "最好",
      );
      expect(catalog.userProfile("user_active").preferred_categories).toEqual([
        "耳机",
      ]);
      expect(
        catalog.userProfile("user_active", { preferred_categories: ["运动"] })
          .preferred_categories,
      ).toEqual(["运动"]);
    } finally {
      catalog.close();
    }
  });

  it("拒绝模型编造的商品 ID", () => {
    const catalog = createCatalog();
    try {
      const profile = catalog.userProfile("user_active");
      expect(() =>
        catalog.finalize(
          [
            {
              product_id: "UNKNOWN",
              reason: "不存在",
              marketing_copy: "不存在",
            },
          ],
          { user_id: "user_active" },
          profile,
        ),
      ).toThrowError(new CatalogError("unknown_recommended_product"));
    } finally {
      catalog.close();
    }
  });
});

describe("Harness-owned Evidence", () => {
  it("把 partial evidence 保留为不含业务正文的诊断快照", () => {
    const evidence = createEvidence();
    evidence.usedTools.push("get_user_profile", "search_products");
    evidence.recalledProductIds.add("P023");
    evidence.callLog.push('search_products({"maxPriceCents":30000})');

    expect(snapshotEvidence(evidence)).toEqual({
      usedTools: ["get_user_profile", "search_products"],
      recalledProductIds: ["P023"],
      inStockProductIds: [],
      groundedProductIds: [],
      knowledgeHits: 0,
      callLog: ['search_products({"maxPriceCents":30000})'],
    });
  });

  it("允许重复调用与后两步交换，但守住前三步依赖", () => {
    expect(
      validateToolSequence([
        "get_user_profile",
        "search_products",
        "search_products",
        "check_inventory",
        "get_marketing_strategy",
        "retrieve_knowledge",
      ]),
    ).toBeNull();
    expect(
      validateToolSequence([
        "search_products",
        "get_user_profile",
        "check_inventory",
        "retrieve_knowledge",
        "get_marketing_strategy",
      ]),
    ).toContain("依赖顺序错误");
  });

  it("只接受被召回、有库存且有知识支撑的推荐", () => {
    const catalog = createCatalog();
    try {
      const evidence = createEvidence();
      evidence.profile = catalog.userProfile("user_active");
      evidence.usedTools.push("get_user_profile");
      const products = catalog.search({
        profile: evidence.profile,
        categories: ["耳机"],
        min_price_cents: 0,
        max_price_cents: 300_000,
        tags: [],
        limit: 5,
      });
      recordSearch(
        evidence,
        products.map((item) => item.product_id),
      );
      recordInventory(
        evidence,
        catalog
          .inventory(products.map((item) => item.product_id))
          .map((item) => item.product_id),
      );
      const hits = catalog.retrieveKnowledge({
        query: "降噪 耳机",
        categories: ["耳机"],
        product_ids: products.map((item) => item.product_id),
        limit: 3,
      });
      recordKnowledge(
        evidence,
        hits,
        products.map((item) => item.product_id),
      );
      evidence.usedTools.push("get_marketing_strategy");
      const valid = [
        {
          product_id: products[0]!.product_id,
          reason: "有依据",
          marketing_copy: "克制",
        },
      ];
      expect(() =>
        validateRecommendationEvidence(evidence, valid),
      ).not.toThrow();
      expect(() =>
        validateRecommendationEvidence(evidence, [
          { product_id: "P999", reason: "编造", marketing_copy: "编造" },
        ]),
      ).toThrowError(EvidenceError);
    } finally {
      catalog.close();
    }
  });
});
