import assert from "node:assert/strict";
import test from "node:test";
import type { SellerOrder } from "../app/components/seller/orderData";
import { summarizeAutomationImpact } from "../app/components/seller/productMetrics";

const BASE_ORDER: SellerOrder = {
  id: "ORD-TEST",
  customer: "cx-test",
  product: "测试商品",
  period: "2026-07-01 至 2026-07-02",
  size: "M",
  amount: "¥100",
  status: "待复核",
  channel: "测试渠道",
  updatedAt: "刚刚",
  risk: "无",
  address: "杭州市西湖区",
  automation: {
    mode: "ai_resolved",
    savedMinutes: 0,
    preventedError: false,
    evidence: "测试证据",
    nextStep: "测试下一步",
  },
  notes: [],
  timeline: [],
};

/** Creates a seller order row with only the automation fields overridden. */
function orderWithAutomation(
  id: string,
  automation: SellerOrder["automation"],
): SellerOrder {
  return {
    ...BASE_ORDER,
    id,
    automation,
  };
}

test("summarizeAutomationImpact turns workflow rows into product metrics", () => {
  const summary = summarizeAutomationImpact([
    orderWithAutomation("ORD-1", {
      mode: "ai_resolved",
      savedMinutes: 10,
      preventedError: true,
      evidence: "自动回答押金规则",
      nextStep: "同步物流",
    }),
    orderWithAutomation("ORD-2", {
      mode: "human_review",
      savedMinutes: 5,
      preventedError: true,
      evidence: "尺码需要人工判断",
      nextStep: "复核尺码",
    }),
  ]);

  assert.equal(summary.totalOrders, 2);
  assert.equal(summary.aiResolved, 1);
  assert.equal(summary.humanReview, 1);
  assert.equal(summary.automationRate, 50);
  assert.equal(summary.savedMinutes, 15);
  assert.equal(summary.preventedErrors, 2);
  assert.deepEqual(
    summary.metrics.map((metric) => metric.label),
    ["AI 自动推进", "节省工时", "错误拦截", "人工接手"],
  );
});

test("summarizeAutomationImpact handles an empty order list", () => {
  const summary = summarizeAutomationImpact([]);

  assert.equal(summary.totalOrders, 0);
  assert.equal(summary.automationRate, 0);
  assert.equal(summary.savedMinutes, 0);
  assert.equal(summary.preventedErrors, 0);
});
