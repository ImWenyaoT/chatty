/**
 * 把一轮已通过 Evidence 校验的回复，绑定成 json-render 的 spec。
 *
 * 这一步是确定性代码，不经过模型：模型此前只提供了 product_id、推荐理由和文案，
 * 价格、库存、品牌都是 `Catalog.finalize()` 从 SQLite 重查出来的。到了这里再选
 * 用哪个组件、把哪些字段绑上去，模型没有任何机会插手。
 *
 * 选组件的规则也是确定性的：多于一个商品用对比表，否则用卡片列表。
 */

import type { Spec, UIElement } from "@json-render/core";

import type { RecommendedProduct } from "../data/models.ts";

export function buildRenderSpec(
  products: readonly RecommendedProduct[],
  answer: string | null,
): Spec | null {
  const elements: Record<string, UIElement> = {};
  const children: string[] = [];

  const push = (element: UIElement): void => {
    const key = `el-${children.length}`;
    elements[key] = element;
    children.push(key);
  };

  if (answer) push({ type: "policy_note", props: { text: answer } });

  if (products.length > 1) {
    push({ type: "product_table", props: { products: [...products] } });
  } else {
    for (const product of products) {
      push({ type: "product_card", props: { ...product } });
    }
  }

  if (children.length === 0) return null;
  elements["root"] = { type: "stack", props: {}, children };
  return { root: "root", elements };
}
