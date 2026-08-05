/**
 * 把 Harness Evidence 投影为模型可见状态，并约束下一批 Tool 调用。
 *
 * 主 Agent 可能一次提出多个 Tool call。这个文件在 Tool 真正执行前，根据 Evidence 为整批
 * 调用做决定：哪些允许、哪些重复、哪些当前阶段不能调用。决定会返回 Model，让它下一轮
 * 可以自行纠正；Harness 不依靠 Model 对自身调用历史的描述。
 */

import type { RecommendationEvidence } from "./evidence.ts";

/** Agent Loop 只有两个阶段：补齐支撑材料，或者已经可以生成草稿。 */
export const WorkflowStage = {
  NEED_SUPPORT: "need_support",
  READY_TO_DRAFT: "ready_to_draft",
} as const;
export type WorkflowStage = (typeof WorkflowStage)[keyof typeof WorkflowStage];

/** 单个 Tool call 的门禁结果。 */
export type GateDecision = {
  allowed: boolean;
  reason: string | null;
};

/** 同一次 Model 响应中全部 Tool call 的冻结决策。 */
export type ToolBatch = {
  stage: WorkflowStage;
  decisions: Map<string, GateDecision>;
};

/** Evidence 是唯一状态源；阶段不单独持久化，避免两份状态漂移。 */
export function stageFor(evidence: RecommendationEvidence): WorkflowStage {
  // 转成 Set 后只关心“是否完成”，不关心同一 Tool 调用了几次。
  const used = new Set(evidence.used_tools);
  if (!evidence.required_support_tools.every((tool) => used.has(tool))) {
    return WorkflowStage.NEED_SUPPORT;
  }
  if (
    !evidence.required_knowledge_scopes.every((scope) =>
      evidence.completed_knowledge_scopes.has(scope),
    )
  ) {
    return WorkflowStage.NEED_SUPPORT;
  }
  return WorkflowStage.READY_TO_DRAFT;
}

/** 返回当前 Evidence 状态下 Model 下一步可以调用的 Tool 名称。 */
export function allowedTools(evidence: RecommendationEvidence): string[] {
  const used = new Set(evidence.used_tools);
  const allowed: string[] = [];

  // 知识检索允许改写 query 重试，但整个 Agent Loop 最多三次。
  const knowledgeCalls = evidence.used_tools.filter(
    (tool) => tool === "retrieve_knowledge",
  ).length;
  if (knowledgeCalls < 3) allowed.push("retrieve_knowledge");
  if (
    evidence.required_support_tools.includes("get_marketing_strategy") &&
    !used.has("get_marketing_strategy")
  ) {
    allowed.push("get_marketing_strategy");
  }
  return allowed;
}

/** 在 Tool 执行前冻结整批决策，避免并发调用依赖完成先后顺序。 */
export function planToolBatch(
  evidence: RecommendationEvidence,
  calls: readonly (readonly [string, string])[],
): ToolBatch {
  // 在任何 Tool 开始前读取一次 Evidence，整批调用都基于同一个快照做决定。
  const stage = stageFor(evidence);
  const allowed = new Set(allowedTools(evidence));
  const accepted = new Set<string>();
  const decisions = new Map<string, GateDecision>();

  for (const [callId, toolName] of calls) {
    if (!allowed.has(toolName)) {
      decisions.set(callId, { allowed: false, reason: "tool_not_allowed_in_stage" });
    } else if (accepted.has(toolName)) {
      // 同一批重复 Tool 看不到彼此结果，所以只允许第一个执行。
      decisions.set(callId, { allowed: false, reason: "duplicate_tool_in_batch" });
    } else {
      decisions.set(callId, { allowed: true, reason: null });
      accepted.add(toolName);
    }
  }
  return { stage, decisions };
}

/**
 * 只披露进度与下一步，不把 Harness-owned Evidence 交给模型。
 *
 * 返回普通字符串而不是对象，因为它会作为 developer message 加入 Model Context。
 * 商品 ID、画像详情等真实 Evidence 不放进去，避免 Model 反过来篡改 Harness 判断。
 */
export function renderAgentStatus(evidence: RecommendationEvidence): string {
  const stage = stageFor(evidence);
  const completed = [...new Set(evidence.used_tools)].join(", ") || "none";
  const requiredScopes = evidence.required_knowledge_scopes.join(", ") || "none";
  const completedScopes =
    [...evidence.completed_knowledge_scopes].sort().join(", ") || "none";
  const nextSteps = allowedTools(evidence);
  if (stage === WorkflowStage.READY_TO_DRAFT) nextSteps.push("final_output");
  // version 不是数据库版本，只是让 Model 看出状态是否比上一轮有进展。
  const version = evidence.used_tools.length + evidence.blocked_attempts.length;
  return [
    `<agent_status version="${version}">`,
    `stage: ${stage}`,
    `completed_steps: ${completed}`,
    `required_knowledge_scopes: ${requiredScopes}`,
    `completed_knowledge_scopes: ${completedScopes}`,
    `allowed_next: ${nextSteps.join(", ")}`,
    `blocked_attempts: ${evidence.blocked_attempts.length}`,
    "</agent_status>",
  ].join("\n");
}
