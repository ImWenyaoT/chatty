/**
 * 一次 Agent Loop 内被 Tool、门禁与 Executor 共享的运行时状态。
 *
 * 这些类型本身不含逻辑。单独成文件是为了让 `tools.ts` 与 `workflow.ts` 都依赖它，
 * 而不是互相依赖——两者各自需要对方的一个类型，直接引用会形成环。
 */

import type { Catalog } from "../data/catalog.ts";
import type { RecommendationRequest } from "../data/models.ts";
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

/**
 * 一批 Tool call 共享的冻结状态。
 *
 * stage 与 allowed 在批次开始时定格，因此同批调用不会因为彼此的执行顺序拿到不同结论；
 * accepted 随批次推进增长，用来拦截同批重复 Tool。
 */
export type ToolBatchState = {
  stage: WorkflowStage;
  allowed: Set<string>;
  accepted: Set<string>;
};

/** 一次 Agent Loop 内 Tool 共享的对象，不会写入用户会话。 */
export type ChattyRunContext = {
  // 纯知识问答没有商品请求，因此 request 可以是 null。
  request: RecommendationRequest | null;
  // catalog 是 SQLite 查询入口；Tool 不直接写 SQL。
  catalog: Catalog;
  // evidence 是 Harness 账本，只能由确定性 Tool 代码更新。
  evidence: RecommendationEvidence;
  // batch 由 workflow 为“当前这批 Tool 调用”临时冻结。
  batch: ToolBatchState | null;
};

export function createRunContext(
  request: RecommendationRequest | null,
  catalog: Catalog,
  evidence: RecommendationEvidence,
): ChattyRunContext {
  return { request, catalog, evidence, batch: null };
}
