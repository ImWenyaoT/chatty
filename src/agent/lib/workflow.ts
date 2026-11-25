/**
 * 把 Harness Evidence 投影为模型可见状态，并约束下一批 Tool 调用。
 *
 * 主 Agent 可能一次提出多个 Tool call。这个文件在 Tool 真正执行前，根据 Evidence 为整批
 * 调用做决定：哪些允许、哪些重复、哪些当前阶段不能调用。决定会返回 Model，让它下一轮
 * 可以自行纠正；Harness 不依靠 Model 对自身调用历史的描述。
 */

import {
  WorkflowStage,
  type GateDecision,
  type KnowledgeScope,
  type ToolBatchState,
} from "./context.ts";
import type { RecommendationEvidence } from "./evidence.ts";

/** 同一次 Model 响应中全部 Tool call 的冻结决策。 */
export type ToolBatch = {
  stage: WorkflowStage;
  decisions: Map<string, GateDecision>;
};

/** 在任何 Tool 执行前读取一次 Evidence，作为整批调用的唯一判断依据。 */
export function openToolBatch(
  evidence: RecommendationEvidence,
): ToolBatchState {
  return {
    stage: stageFor(evidence),
    allowed: new Set(allowedTools(evidence)),
    accepted: new Set(),
  };
}

/** 按冻结快照裁决单个 Tool call，并把放行结果记入批次。 */
export function gateToolCall(
  batch: ToolBatchState,
  toolName: string,
): GateDecision {
  if (!batch.allowed.has(toolName)) {
    return { allowed: false, reason: "tool_not_allowed_in_stage" };
  }
  // 同一批重复 Tool 看不到彼此结果，所以只允许第一个执行。
  if (batch.accepted.has(toolName)) {
    return { allowed: false, reason: "duplicate_tool_in_batch" };
  }
  batch.accepted.add(toolName);
  return { allowed: true, reason: null };
}

/** 每个知识范围各自的检索上限；一个 scope 不能耗尽另一个 scope 的预算。 */
export const MAX_KNOWLEDGE_CALLS_PER_SCOPE = 3;

/** 一个 scope 算不算「查过了」：命中过，或者检索预算已经用完。 */
function knowledgeScopeSettled(
  evidence: RecommendationEvidence,
  scope: KnowledgeScope,
): boolean {
  if (evidence.completed_knowledge_scopes.has(scope)) return true;
  // 查了三次一条都没命中，也是一个确定的结论：知识库里没有。
  // 此时必须让模型收尾并如实说明，否则 allowed_next 为空又不给 final_output，
  // 模型会被告知它什么都不能做——提示词允许的诚实回答反而成了死局。
  return knowledgeCallCount(evidence, scope) >= MAX_KNOWLEDGE_CALLS_PER_SCOPE;
}

/** 指定 scope 已经发起过几次知识检索。 */
export function knowledgeCallCount(
  evidence: RecommendationEvidence,
  scope: KnowledgeScope,
): number {
  return evidence.attempted_knowledge_scopes.get(scope) ?? 0;
}

/** Evidence 是唯一状态源；阶段不单独持久化，避免两份状态漂移。 */
export function stageFor(evidence: RecommendationEvidence): WorkflowStage {
  // 转成 Set 后只关心“是否完成”，不关心同一 Tool 调用了几次。
  const used = new Set(evidence.used_tools);
  if (!evidence.required_support_tools.every((tool) => used.has(tool))) {
    return WorkflowStage.NEED_SUPPORT;
  }
  if (
    !evidence.required_knowledge_scopes.every((scope) =>
      knowledgeScopeSettled(evidence, scope),
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

  // 只要还有必需 scope 未完成且未用尽自己的预算，就允许继续检索。
  if (
    evidence.required_knowledge_scopes.some(
      (scope) => !knowledgeScopeSettled(evidence, scope),
    )
  ) {
    allowed.push("retrieve_knowledge");
  }
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
  const batch = openToolBatch(evidence);
  const decisions = new Map<string, GateDecision>();
  for (const [callId, toolName] of calls) {
    decisions.set(callId, gateToolCall(batch, toolName));
  }
  return { stage: batch.stage, decisions };
}

/**
 * 只披露进度、下一步与最终输出契约，不把 Harness-owned Evidence 交给模型。
 *
 * 返回普通字符串而不是对象，因为它会作为 system message 加入 Model Context。
 * 商品 ID、画像详情等真实 Evidence 不放进去，避免 Model 反过来篡改 Harness 判断。
 */
/** 把 allowed_final_actions 这行读数翻译成模型可以直接照做的结论。 */
function finalActionCheck(evidence: RecommendationEvidence): string {
  const allowed = evidence.allowed_final_actions;
  if (allowed.length === 0) return "task context not prepared";
  if (!allowed.includes("answer")) {
    return `'answer' is NOT allowed this turn (product request present) — use ${allowed.join(" or ")}`;
  }
  return `only 'answer' is allowed this turn (no product request)`;
}

export function renderAgentStatus(evidence: RecommendationEvidence): string {
  const stage = stageFor(evidence);
  const completed = [...new Set(evidence.used_tools)].join(", ") || "none";
  const requiredScopes =
    evidence.required_knowledge_scopes.join(", ") || "none";
  const completedScopes =
    [...evidence.completed_knowledge_scopes].sort().join(", ") || "none";
  const knowledgeCalls =
    evidence.required_knowledge_scopes
      .map(
        (scope) =>
          `${scope} ${knowledgeCallCount(evidence, scope)}/${MAX_KNOWLEDGE_CALLS_PER_SCOPE}`,
      )
      .join(", ") || "none";
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
    `knowledge_calls: ${knowledgeCalls}`,
    `allowed_next: ${nextSteps.join(", ")}`,
    `allowed_final_action: ${evidence.allowed_final_actions.join(", ") || "none"}`,
    // 读数旁边给结论：模型信状态栏，但「信」不等于「知道该怎么用」。
    `final_action_check: ${finalActionCheck(evidence)}`,
    `blocked_attempts: ${evidence.blocked_attempts.length}`,
    "</agent_status>",
  ].join("\n");
}

/** 被阶段门禁拦截时，返回给 Model 的 Tool Result 形状。 */
export function blockedToolPayload(
  evidence: RecommendationEvidence,
  stage: WorkflowStage,
  toolName: string,
  reason: string,
): string {
  evidence.blocked_attempts.push(`${stage}:${toolName}:${reason}`);
  return JSON.stringify({
    status: "blocked",
    reason,
    required_next: allowedTools(evidence),
    agent_status: renderAgentStatus(evidence),
  });
}
