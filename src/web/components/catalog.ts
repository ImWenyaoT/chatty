/**
 * 前端可渲染组件的白名单。
 *
 * 模型（以及 Harness）只能请求渲染这里声明过的组件、只能传这里声明过的字段。
 * 它不能塞任意 HTML，也不能凭空造一个价格字段——props 的 Zod schema 就是边界。
 *
 * 这与「商品价格和库存必须来自 SQLite」是同一条约束在渲染层的延续：
 * 组件负责怎么显示，值仍然由 Harness 从 SQLite 取出后绑定进来。
 */

import { defineCatalog } from "@json-render/core";
import { elementTreeSchema } from "@json-render/react";
import { z } from "zod";

const productProps = z.object({
  product_id: z.string(),
  name: z.string(),
  brand: z.string(),
  category: z.string(),
  price_cents: z.number().int(),
  stock: z.number().int(),
  low_stock: z.boolean(),
  tags: z.array(z.string()),
  reason: z.string(),
  marketing_copy: z.string(),
});

export const chattyCatalog = defineCatalog(elementTreeSchema, {
  components: {
    /** 单个商品卡：推荐结果的默认形态。 */
    product_card: {
      description: "展示一个商品的名称、价格、库存与推荐理由",
      props: productProps,
    },
    /** 多商品并排对比：适合「A 和 B 哪个好」这类请求。 */
    product_table: {
      description: "把多个商品并排成表格，便于比较价格与库存",
      props: z.object({ products: z.array(productProps) }),
    },
    /** 纵向容器：唯一的布局原语，chatty 不需要更复杂的排布。 */
    stack: {
      description: "把若干子元素纵向排列",
      props: z.object({}),
    },
    /** 政策/知识回答：混合请求里那半段文字。 */
    policy_note: {
      description: "展示一段有知识检索依据的政策或事实说明",
      props: z.object({ text: z.string() }),
    },
  },
  // chatty 的卡片是只读展示，不给模型任何可触发的动作。
  actions: {},
});

export type ChattyCatalog = typeof chattyCatalog;
