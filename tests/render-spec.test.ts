import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chattyCatalog } from "../src/web/components/catalog.ts";
import { buildRenderSpec } from "../src/web/render-spec.ts";
import type { RecommendedProduct } from "../src/data/models.ts";

function product(id: string, name: string): RecommendedProduct {
  return {
    product_id: id,
    name,
    category: "耳机",
    price_cents: 29900,
    brand: "TestBrand",
    stock: 5,
    tags: ["降噪"],
    low_stock: false,
    reason: "符合预算与画像",
    marketing_copy: "文案",
  };
}

describe("渲染 spec", () => {
  it("单商品用卡片，多商品自动切成对比表", () => {
    const one = buildRenderSpec([product("P1", "A")], null);
    assert.equal(one?.elements["el-0"]?.type, "product_card");

    const many = buildRenderSpec(
      [product("P1", "A"), product("P2", "B")],
      null,
    );
    assert.equal(many?.elements["el-0"]?.type, "product_table");
  });

  it("有知识回答时排在商品之前", () => {
    const spec = buildRenderSpec([product("P1", "A")], "七天无理由退货");

    assert.equal(spec?.elements["el-0"]?.type, "policy_note");
    assert.equal(spec?.elements["el-1"]?.type, "product_card");
    assert.deepStrictEqual(spec?.elements["root"]?.children, ["el-0", "el-1"]);
  });

  it("没有内容时返回 null，不渲染空容器", () => {
    assert.equal(buildRenderSpec([], null), null);
  });

  // 这是 catalog 的意义：spec 里出现的每个组件都必须是白名单里声明过的。
  // 越界的组件名在渲染期才炸，这条测试让它在 CI 就炸。
  it("spec 只使用 catalog 声明过的组件", () => {
    const allowed = new Set(chattyCatalog.componentNames);
    const spec = buildRenderSpec(
      [product("P1", "A"), product("P2", "B")],
      "七天无理由退货",
    );

    for (const element of Object.values(spec?.elements ?? {})) {
      assert.ok(
        allowed.has(element.type),
        `${element.type} 不在 catalog 白名单里`,
      );
    }
  });
});
