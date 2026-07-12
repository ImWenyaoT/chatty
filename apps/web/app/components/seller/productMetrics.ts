import type { SellerOrder } from "./orderData";

type ProductMetric = {
  label: string;
  value: string;
  hint: string;
};

export type AutomationSummary = {
  totalOrders: number;
  aiResolved: number;
  humanReview: number;
  automationRate: number;
  savedMinutes: number;
  preventedErrors: number;
  metrics: ProductMetric[];
};

/** Converts seller workflow rows into business-facing AI impact metrics. */
export function summarizeAutomationImpact(
  orders: SellerOrder[],
): AutomationSummary {
  const totalOrders = orders.length;
  const aiResolved = orders.filter(
    (order) => order.automation.mode === "ai_resolved",
  ).length;
  const humanReview = orders.filter(
    (order) => order.automation.mode === "human_review",
  ).length;
  const savedMinutes = orders.reduce(
    (sum, order) => sum + order.automation.savedMinutes,
    0,
  );
  const preventedErrors = orders.filter(
    (order) => order.automation.preventedError,
  ).length;
  const automationRate =
    totalOrders === 0 ? 0 : Math.round((aiResolved / totalOrders) * 100);

  return {
    totalOrders,
    aiResolved,
    humanReview,
    automationRate,
    savedMinutes,
    preventedErrors,
    metrics: [
      {
        label: "AI 自动推进",
        value: `${automationRate}%`,
        hint: `${aiResolved}/${totalOrders} 单无需从零人工回复`,
      },
      {
        label: "节省工时",
        value: `${savedMinutes} min`,
        hint: "按咨询理解、规则检索、跟进提醒估算",
      },
      {
        label: "错误拦截",
        value: `${preventedErrors}`,
        hint: "尺码复核、归还提醒、地址补全等风险",
      },
      {
        label: "人工接手",
        value: `${humanReview}`,
        hint: "保留需要判断的高风险节点",
      },
    ],
  };
}
