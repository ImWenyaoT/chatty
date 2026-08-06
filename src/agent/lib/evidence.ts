/**
 * Harness 用于验证推荐的事实。
 *
 * Tool Result 有两个消费者：模型获得下一轮推理需要的业务结果；Harness 单独保存
 * 更小的 Evidence，用确定性代码校验事实，而不是相信模型对调用过程的描述。
 */

import { Usage } from "@openai/agents";

import { MODEL_TOOL_NAMES } from "./tool-names.ts";

import type {
  KnowledgeHit,
  RecommendationDraftItem,
  UserProfile,
} from "../../data/models.ts";

// Harness 确定性执行的步骤。它们不是模型可调用的 Tool，所以没有对应文件；
// 模型可见的那部分由 agent/tools/ 的目录扫描派生，两者合起来才是 used_tools 的全集。
export const HARNESS_STEPS = [
  "get_user_profile",
  "search_products",
  "check_inventory",
] as const;

export const TOOL_NAMES: readonly string[] = [
  ...HARNESS_STEPS,
  ...MODEL_TOOL_NAMES,
];

// 依赖链就是这三个 Harness 步骤本身：知识检索和营销策略只要求它们已完成，
// 彼此之间可以互换顺序。
export const DEPENDENCY_CHAIN = HARNESS_STEPS;

/** Tool 执行过程中由 Harness 记录、模型看不到的事实。 */
export type RecommendationEvidence = {
  profile: UserProfile | null;
  knowledge: KnowledgeHit[];
  general_knowledge_hits: number;
  recalled_product_ids: Set<string>;
  recalled_product_order: string[];
  in_stock_product_ids: Set<string>;
  in_stock_product_order: string[];
  knowledge_product_ids: Set<string>;
  used_tools: string[];
  call_log: string[];
  blocked_attempts: string[];
  required_support_tools: readonly string[];
  usage: Usage;
  completed_knowledge_scopes: Set<string>;
  required_knowledge_scopes: readonly string[];
  // 本轮最终输出允许的 action。与 finalizeReply 的分支同源，避免状态栏和校验漂移。
  allowed_final_actions: readonly string[];
};

export function createEvidence(): RecommendationEvidence {
  return {
    profile: null,
    knowledge: [],
    general_knowledge_hits: 0,
    recalled_product_ids: new Set(),
    recalled_product_order: [],
    in_stock_product_ids: new Set(),
    in_stock_product_order: [],
    knowledge_product_ids: new Set(),
    used_tools: [],
    call_log: [],
    blocked_attempts: [],
    required_support_tools: ["retrieve_knowledge", "get_marketing_strategy"],
    usage: new Usage(),
    completed_knowledge_scopes: new Set(),
    required_knowledge_scopes: [],
    allowed_final_actions: [],
  };
}

/** 可序列化的诊断快照；不包含画像详情和知识正文。 */
export type EvidenceSnapshot = {
  used_tools: string[];
  profile_segment: string | null;
  recalled_product_ids: string[];
  in_stock_product_ids: string[];
  grounded_product_ids: string[];
  knowledge_hits: number;
  call_log: string[];
};

/** 只复制定位错误需要的字段，避免日志带出整段业务内容。 */
export function snapshotEvidence(
  evidence: RecommendationEvidence,
): EvidenceSnapshot {
  return {
    used_tools: [...evidence.used_tools],
    profile_segment: evidence.profile?.segment ?? null,
    recalled_product_ids: [...evidence.recalled_product_ids].sort(),
    in_stock_product_ids: [...evidence.in_stock_product_ids].sort(),
    grounded_product_ids: [...evidence.knowledge_product_ids].sort(),
    knowledge_hits: evidence.knowledge.length,
    call_log: [...evidence.call_log],
  };
}

/** 记录 Agents SDK 汇总的 Model 请求与 Token 用量。 */
export function recordRunUsage(
  evidence: RecommendationEvidence,
  usage: Usage,
): void {
  evidence.usage.add(usage);
}

/** 检查 Tool 是否齐全，以及前三个 Tool 的依赖顺序。 */
export function validateToolSequence(
  usedTools: readonly string[],
): string | null {
  const expected = new Set<string>(TOOL_NAMES);
  const actual = new Set(usedTools);

  const missing = [...expected].filter((tool) => !actual.has(tool)).sort();
  if (missing.length > 0) return `未调用的工具：${missing.join(", ")}`;

  const unknown = [...actual].filter((tool) => !expected.has(tool)).sort();
  if (unknown.length > 0) return `调用了未注册的工具：${unknown.join(", ")}`;

  for (let index = 1; index < DEPENDENCY_CHAIN.length; index += 1) {
    const previous = usedTools.indexOf(DEPENDENCY_CHAIN[index - 1]!);
    const current = usedTools.indexOf(DEPENDENCY_CHAIN[index]!);
    if (current < previous)
      return `依赖顺序错误，应为 ${DEPENDENCY_CHAIN.join(" -> ")}`;
  }

  return null;
}

/** 同一参数最多调用三次，防止模型陷入没有进展的循环。 */
export function guardRepeatedCall(
  evidence: RecommendationEvidence,
  toolName: string,
  signature: string,
): void {
  const call = `${toolName}(${signature})`;
  evidence.call_log.push(call);

  const repeated = evidence.call_log.filter((logged) => logged === call).length;
  if (repeated > 3) {
    throw new Error(
      `相同参数调用 ${toolName} 已达 3 次，请改变参数后重试或使用现有结果`,
    );
  }
}

/** 记录商品搜索真正返回过的商品 ID。 */
export function recordSearch(
  evidence: RecommendationEvidence,
  productIds: readonly string[],
): void {
  for (const productId of productIds) {
    if (!evidence.recalled_product_ids.has(productId)) {
      evidence.recalled_product_order.push(productId);
    }
    evidence.recalled_product_ids.add(productId);
  }
  evidence.used_tools.push("search_products");
}

/** 记录已经确认有库存的商品 ID。 */
export function recordInventory(
  evidence: RecommendationEvidence,
  productIds: readonly string[],
): void {
  for (const productId of productIds) {
    if (!evidence.in_stock_product_ids.has(productId)) {
      evidence.in_stock_product_order.push(productId);
    }
    evidence.in_stock_product_ids.add(productId);
  }
  evidence.used_tools.push("check_inventory");
}

/** 记录检索命中，以及这些知识能够支撑的商品 ID。 */
export function recordKnowledge(
  evidence: RecommendationEvidence,
  hits: readonly KnowledgeHit[],
  groundedProductIds: readonly string[],
  scope: string,
): void {
  evidence.knowledge.push(...hits);
  evidence.completed_knowledge_scopes.add(scope);
  if (scope === "general") evidence.general_knowledge_hits += hits.length;
  for (const productId of groundedProductIds)
    evidence.knowledge_product_ids.add(productId);
  evidence.used_tools.push("retrieve_knowledge");
}

/** 推荐没有通过 Harness 的确定性 Evidence 校验。 */
export class EvidenceError extends Error {
  readonly code: string;
  readonly missing: string[];
  readonly detail: string | null;

  constructor(
    code: string,
    missing: readonly string[] = [],
    detail: string | null = null,
  ) {
    super(code);
    this.code = code;
    this.missing = [...missing];
    this.detail = detail;
  }
}

/** 要求每个推荐商品都通过召回、库存、知识三组事实校验。 */
export function validateRecommendationEvidence(
  evidence: RecommendationEvidence,
  draft: readonly RecommendationDraftItem[],
): void {
  const sequenceError = validateToolSequence(evidence.used_tools);
  if (sequenceError)
    throw new EvidenceError("required_tools_not_used", [], sequenceError);

  if (evidence.knowledge.length === 0)
    throw new EvidenceError("knowledge_not_retrieved");
  if (evidence.profile === null) throw new EvidenceError("profile_not_loaded");

  const recommended = new Set(draft.map((item) => item.product_id));
  const checks = [
    ["product_not_recalled", evidence.recalled_product_ids],
    ["inventory_not_checked", evidence.in_stock_product_ids],
    ["product_not_grounded", evidence.knowledge_product_ids],
  ] as const;

  // 这里比较的是集合包含关系：模型推荐的每个 ID，都必须出现在
  // Harness 自己记录的事实集合里。
  for (const [errorCode, verified] of checks) {
    const missing = [...recommended].filter((id) => !verified.has(id)).sort();
    if (missing.length > 0) throw new EvidenceError(errorCode, missing);
  }
}

/** 澄清可以没有候选商品，但仍必须完成五个 Tool。 */
export function validateClarificationEvidence(
  evidence: RecommendationEvidence,
): void {
  const sequenceError = validateToolSequence(evidence.used_tools);
  if (sequenceError)
    throw new EvidenceError("required_tools_not_used", [], sequenceError);

  if (evidence.in_stock_product_ids.size > 0) {
    throw new EvidenceError("invalid_recommendation");
  }
}
