import type {
  KnowledgeHit,
  RecommendationDraftItem,
  UserProfile,
} from "./types.js";

export const toolNames = [
  "get_user_profile",
  "search_products",
  "check_inventory",
  "retrieve_knowledge",
  "get_marketing_strategy",
] as const;
export type ToolName = (typeof toolNames)[number];

export interface RecommendationEvidence {
  profile: UserProfile | null;
  knowledge: KnowledgeHit[];
  recalledProductIds: Set<string>;
  inStockProductIds: Set<string>;
  knowledgeProductIds: Set<string>;
  usedTools: string[];
  callLog: string[];
}

export const createEvidence = (): RecommendationEvidence => ({
  profile: null,
  knowledge: [],
  recalledProductIds: new Set(),
  inStockProductIds: new Set(),
  knowledgeProductIds: new Set(),
  usedTools: [],
  callLog: [],
});

// 诊断快照只保留校验事实，不复制用户画像或知识正文，也不会进入模型上下文。
export interface EvidenceSnapshot {
  usedTools: string[];
  profileSegment?: string;
  recalledProductIds: string[];
  inStockProductIds: string[];
  groundedProductIds: string[];
  knowledgeHits: number;
  callLog: string[];
}

export const snapshotEvidence = (
  evidence: RecommendationEvidence,
): EvidenceSnapshot => ({
  usedTools: [...evidence.usedTools],
  ...(evidence.profile ? { profileSegment: evidence.profile.segment } : {}),
  recalledProductIds: [...evidence.recalledProductIds],
  inStockProductIds: [...evidence.inStockProductIds],
  groundedProductIds: [...evidence.knowledgeProductIds],
  knowledgeHits: evidence.knowledge.length,
  callLog: [...evidence.callLog],
});

const dependencyChain: ToolName[] = [
  "get_user_profile",
  "search_products",
  "check_inventory",
];

export function validateToolSequence(usedTools: string[]): string | null {
  const expected = new Set<string>(toolNames);
  const actual = new Set(usedTools);
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  if (missing.length) return `未调用的工具：${missing.join(", ")}`;
  const unknown = [...actual].filter((name) => !expected.has(name)).sort();
  if (unknown.length) return `调用了未注册的工具：${unknown.join(", ")}`;
  const firstUse = dependencyChain.map((name) => usedTools.indexOf(name));
  if (
    firstUse.some(
      (position, index) => index > 0 && position < firstUse[index - 1]!,
    )
  ) {
    return `依赖顺序错误，应为 ${dependencyChain.join(" -> ")}`;
  }
  return null;
}

export function guardRepeatedCall(
  evidence: RecommendationEvidence,
  toolName: string,
  signature: string,
): void {
  const call = `${toolName}(${signature})`;
  evidence.callLog.push(call);
  if (evidence.callLog.filter((entry) => entry === call).length > 3) {
    throw new Error(
      `相同参数调用 ${toolName} 已达 3 次，请改变参数后重试或使用现有结果`,
    );
  }
}

export function recordSearch(
  evidence: RecommendationEvidence,
  productIds: readonly string[],
): void {
  for (const productId of productIds)
    evidence.recalledProductIds.add(productId);
  evidence.usedTools.push("search_products");
}

export function recordInventory(
  evidence: RecommendationEvidence,
  productIds: readonly string[],
): void {
  for (const productId of productIds) evidence.inStockProductIds.add(productId);
  evidence.usedTools.push("check_inventory");
}

export function recordKnowledge(
  evidence: RecommendationEvidence,
  hits: KnowledgeHit[],
  groundedProductIds: readonly string[],
): void {
  evidence.knowledge.push(...hits);
  for (const productId of groundedProductIds)
    evidence.knowledgeProductIds.add(productId);
  evidence.usedTools.push("retrieve_knowledge");
}

export class EvidenceError extends Error {
  constructor(
    readonly code: string,
    readonly missing: string[] = [],
  ) {
    super(code);
  }
}

export function validateRecommendationEvidence(
  evidence: RecommendationEvidence,
  draft: RecommendationDraftItem[],
): void {
  const sequenceError = validateToolSequence(evidence.usedTools);
  if (sequenceError) throw new EvidenceError("required_tools_not_used");
  if (!evidence.knowledge.length)
    throw new EvidenceError("knowledge_not_retrieved");
  if (!evidence.profile) throw new EvidenceError("profile_not_loaded");

  const recommended = new Set(draft.map((item) => item.product_id));
  const checks: Array<[string, Set<string>]> = [
    ["product_not_recalled", evidence.recalledProductIds],
    ["inventory_not_checked", evidence.inStockProductIds],
    ["product_not_grounded", evidence.knowledgeProductIds],
  ];
  for (const [code, source] of checks) {
    const missing = [...recommended].filter((id) => !source.has(id)).sort();
    if (missing.length) throw new EvidenceError(code, missing);
  }
}
