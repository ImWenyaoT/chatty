import { DatabaseSync } from "node:sqlite";
import { CommerceStore } from "./commerce.js";
import { MemoryStore, SupportRequestStore } from "./stores.js";

export type DemoDataSummary = {
  orders: number;
  memories: number;
  support_requests: number;
};

const products = [
  ["SUIT-002", "深灰单排扣西装"],
  ["SUIT-003", "海军蓝三件套西装"],
  ["SHIRT-001", "白色礼服衬衫"],
  ["VEST-001", "黑色修身马甲"],
  ["COAT-001", "驼色羊毛大衣"],
] as const;

const memories = [
  "常穿 L 码上装",
  "偏好深色、低调的商务风格",
  "重要场合希望提前两天送达",
  "不接受含羊毛刺痒感明显的面料",
  "默认收货城市为上海",
  "更倾向租赁而不是买断",
  "参加晚间活动时偏好三件套",
  "需要可搭配黑色牛津鞋的款式",
  "希望订单变更通过 Chatty 确认",
  "通常需要开具个人抬头发票",
] as const;

const supportCases = [
  ["改期需人工确认", "客户希望调整已确认订单的租赁日期。"],
  ["特殊尺码咨询", "客户需要当前标准尺码之外的加长袖版本。"],
  ["加急配送评估", "活动日期临近，需要人工确认同城加急能力。"],
  ["面料过敏确认", "客户对羊毛敏感，需要人工核实具体面料成分。"],
  ["企业发票协助", "客户需要企业抬头及税号相关开票协助。"],
] as const;

function dateAtDayOffset(offset: number): string {
  return new Date(Date.UTC(2026, 7, 1 + offset)).toISOString().slice(0, 10);
}

function seedCatalog(database: DatabaseSync): void {
  const insertProduct = database.prepare(
    "INSERT OR IGNORE INTO products (id, name) VALUES (?, ?)",
  );
  const insertVariant = database.prepare(
    `INSERT OR IGNORE INTO product_variants (product_id, size, stock)
     VALUES (?, ?, 8)`,
  );
  for (const [productId, name] of products) {
    insertProduct.run(productId, name);
    for (const size of ["M", "L", "XL"]) insertVariant.run(productId, size);
  }
}

export function seedDemoData(databasePath: string): DemoDataSummary {
  const commerce = new CommerceStore(databasePath);
  const memory = new MemoryStore(databasePath);
  const support = new SupportRequestStore(databasePath);
  try {
    seedCatalog(commerce.database);
    const orderIds = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      const [productId] = products[index % products.length]!;
      const fulfillmentMode = index % 2 === 0 ? "rental" : "buyout";
      const startDate = dateAtDayOffset(index * 3);
      let order = commerce.createOrder({
        idempotency_key: `demo-seed:order:${String(index + 1).padStart(2, "0")}`,
        customer_id: `demo-customer-${String((index % 6) + 1).padStart(2, "0")}`,
        session_id: `demo-session-${String((index % 8) + 1).padStart(2, "0")}`,
        product_id: productId,
        size: ["M", "L", "XL"][index % 3]!,
        fulfillment_mode: fulfillmentMode,
        quantity: 1,
        start_date: fulfillmentMode === "rental" ? startDate : null,
        end_date:
          fulfillmentMode === "rental" ? dateAtDayOffset(index * 3 + 3) : null,
        amount_cents: 38_000 + index * 2_500,
        channel: ["Chatty", "小红书", "微信"][index % 3]!,
        address: ["上海市静安区", "上海市徐汇区", "杭州市西湖区"][index % 3]!,
        risk: ["无", "活动日期临近", "需确认面料偏好"][index % 3]!,
      });
      const targetStatus = ["pending", "confirmed", "cancelled"][index % 3];
      if (
        (targetStatus === "confirmed" || targetStatus === "cancelled") &&
        order.status === "pending"
      ) {
        order = commerce.confirmOrder(order.id);
      }
      if (targetStatus === "cancelled" && order.status !== "cancelled") {
        order = commerce.cancelOrder(order.id);
      }
      orderIds.add(order.id);
    }

    memory.bindSession("demo-memory-session", "demo-customer");
    for (const [index, fact] of memories.entries()) {
      const sourceId = `demo-seed:memory:${String(index + 1).padStart(2, "0")}`;
      const exists = memory
        .search("demo-customer", fact, 10)
        .some((item) => item.fact === fact && item.source_id === sourceId);
      if (!exists) memory.save("demo-customer", fact, sourceId);
    }

    const supportIds = new Set<string>();
    for (const [index, [reason, context]] of supportCases.entries()) {
      const number = String(index + 1).padStart(2, "0");
      supportIds.add(
        support.create({
          customer_id: `demo-customer-${number}`,
          session_id: `demo-support-session-${number}`,
          reason,
          context,
          model_context:
            "由 demo seed 生成，用于检查 Harness 的 Handoff receipt 展示。",
          prior_actions: ["已收集客户诉求", "尚未承诺人工处理结果"],
          idempotency_key: `demo-seed:support:${number}`,
        }).id,
      );
    }

    return {
      orders: orderIds.size,
      memories: memories.length,
      support_requests: supportIds.size,
    };
  } finally {
    support.close();
    memory.close();
    commerce.close();
  }
}
