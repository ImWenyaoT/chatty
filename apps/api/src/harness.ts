import { ZodError } from "zod";
import type {
  ArtifactStatus,
  CustomerMemory,
  KnowledgeRecord,
  MemoryEvent,
  Order,
} from "@chatty/contracts";
import { CommerceError, CommerceStore } from "./commerce.js";
import { ArtifactStore } from "./artifacts.js";
import {
  MemoryStore,
  SupportRequestIdempotencyConflictError,
  SupportRequestStore,
  TraceStore,
} from "./stores.js";

export type BusinessOutcome = "verified" | "not_completed" | "not_applicable";

const mutationTools = new Set([
  "create_order",
  "confirm_order",
  "cancel_order",
  "save_research_artifact",
  "save_content_artifact",
  "export_artifact",
]);

export class InvalidAgentOutputError extends Error {}
export class HandoffPersistenceError extends Error {}
export class HandoffIdempotencyConflictError extends Error {}

export type BusinessToolReceipt = {
  tool_name: string;
  ok: boolean;
  order_id: string | null;
  expected_status: string | null;
  artifact_id: string | null;
  expected_artifact_status: ArtifactStatus | null;
  delivery_id: string | null;
  expected_content_hash: string | null;
  evidence: string | null;
  error: string | null;
};

export class HarnessContext {
  readonly businessReceipts: BusinessToolReceipt[] = [];
  readonly priorActions: string[] = [];

  constructor(
    readonly customerId: string,
    readonly sessionId: string,
    readonly commerce: CommerceStore,
    readonly artifacts: ArtifactStore,
  ) {}

  recordReadSuccess(toolName: string, evidence: string): void {
    this.priorActions.push(`${toolName}:ok`);
    this.businessReceipts.push({
      tool_name: toolName,
      ok: true,
      order_id: null,
      expected_status: null,
      artifact_id: null,
      expected_artifact_status: null,
      delivery_id: null,
      expected_content_hash: null,
      evidence,
      error: null,
    });
  }

  recordOrderSuccess(toolName: string, order: Order): void {
    this.priorActions.push(`${toolName}:ok`);
    this.businessReceipts.push({
      tool_name: toolName,
      ok: true,
      order_id: order.id,
      expected_status: order.status,
      artifact_id: null,
      expected_artifact_status: null,
      delivery_id: null,
      expected_content_hash: null,
      evidence: null,
      error: null,
    });
  }

  recordArtifactSuccess(
    toolName: string,
    artifactId: string,
    status: ArtifactStatus,
  ): void {
    this.priorActions.push(`${toolName}:ok`);
    this.businessReceipts.push({
      tool_name: toolName,
      ok: true,
      order_id: null,
      expected_status: null,
      artifact_id: artifactId,
      expected_artifact_status: status,
      delivery_id: null,
      expected_content_hash: null,
      evidence: null,
      error: null,
    });
  }

  recordDeliverySuccess(
    toolName: string,
    deliveryId: string,
    contentHash: string,
  ): void {
    this.priorActions.push(`${toolName}:ok`);
    this.businessReceipts.push({
      tool_name: toolName,
      ok: true,
      order_id: null,
      expected_status: null,
      artifact_id: null,
      expected_artifact_status: null,
      delivery_id: deliveryId,
      expected_content_hash: contentHash,
      evidence: null,
      error: null,
    });
  }

  recordFailure(toolName: string, error: unknown): void {
    this.priorActions.push(`${toolName}:failed`);
    this.businessReceipts.push({
      tool_name: toolName,
      ok: false,
      order_id: null,
      expected_status: null,
      artifact_id: null,
      expected_artifact_status: null,
      delivery_id: null,
      expected_content_hash: null,
      evidence: null,
      error: errorCode(error),
    });
  }

  verifyBusinessOutcome(): [BusinessOutcome, string | null] {
    if (this.businessReceipts.length === 0) return ["not_applicable", null];
    const mutations = this.businessReceipts.filter((receipt) =>
      mutationTools.has(receipt.tool_name),
    );
    const latest = mutations.at(-1) ?? this.businessReceipts.at(-1)!;
    if (!latest.ok)
      return ["not_completed", `${latest.tool_name}:${latest.error}`];
    if (latest.delivery_id !== null && latest.expected_content_hash !== null) {
      const delivery = this.artifacts.getDelivery(
        latest.delivery_id,
        this.customerId,
      );
      if (delivery.content_hash !== latest.expected_content_hash) {
        throw new CommerceError("unverified_business_outcome");
      }
      return ["verified", `delivery:${delivery.id}:${delivery.content_hash}`];
    }
    if (latest.evidence !== null) return ["verified", latest.evidence];
    if (
      latest.artifact_id !== null &&
      latest.expected_artifact_status !== null
    ) {
      const artifact = this.artifacts.get(latest.artifact_id);
      if (artifact.status !== latest.expected_artifact_status) {
        throw new CommerceError("unverified_business_outcome");
      }
      return ["verified", `artifact:${artifact.id}:${artifact.status}`];
    }
    if (latest.order_id === null || latest.expected_status === null) {
      throw new CommerceError("missing_completion_evidence");
    }
    const persisted = this.commerce.getOrder(latest.order_id);
    if (persisted.status !== latest.expected_status) {
      throw new CommerceError("unverified_business_outcome");
    }
    return [
      "verified",
      `${latest.tool_name}:${persisted.id}:${persisted.status}`,
    ];
  }
}

export class AgentContext extends HarnessContext {
  readonly memoryEvents: MemoryEvent[] = [];
  supportRequestId: string | null = null;

  constructor(input: {
    customerId: string;
    sessionId: string;
    message: string;
    traceId: string;
    requestId: string;
    commerce: CommerceStore;
    artifactStore: ArtifactStore;
    memoryStore: MemoryStore;
    supportStore: SupportRequestStore;
    traceStore: TraceStore;
  }) {
    super(
      input.customerId,
      input.sessionId,
      input.commerce,
      input.artifactStore,
    );
    this.message = input.message;
    this.traceId = input.traceId;
    this.requestId = input.requestId;
    this.memoryStore = input.memoryStore;
    this.supportStore = input.supportStore;
    this.traceStore = input.traceStore;
  }

  readonly message: string;
  readonly traceId: string;
  readonly requestId: string;
  readonly memoryStore: MemoryStore;
  readonly supportStore: SupportRequestStore;
  readonly traceStore: TraceStore;
}

export type AgentRunResult = {
  reply: string;
  knowledge_search_results: KnowledgeRecord[];
  memory_events: MemoryEvent[];
  business_outcome: BusinessOutcome;
  completion_evidence: string | null;
  support_request_id: string | null;
};

export function createHandoff(
  context: AgentContext,
  reason: string,
  modelContext: string,
): { support_request_id: string; status: string } {
  try {
    const receipt = context.supportStore.create({
      customer_id: context.customerId,
      session_id: context.sessionId,
      reason,
      context: context.message.trim(),
      model_context: modelContext,
      prior_actions: [...context.priorActions],
      idempotency_key: `${context.customerId}:${context.sessionId}:${context.requestId}:handoff`,
    });
    context.supportRequestId = receipt.id;
    context.traceStore.recordToolEvent(
      context.traceId,
      "completed",
      "create_handoff created receipt",
    );
    return { support_request_id: receipt.id, status: receipt.status };
  } catch (error) {
    context.priorActions.push("create_handoff:failed");
    if (error instanceof SupportRequestIdempotencyConflictError) {
      throw new HandoffIdempotencyConflictError("handoff_idempotency_conflict");
    }
    context.traceStore.recordToolEvent(
      context.traceId,
      "failed",
      "create_handoff failed",
    );
    throw new HandoffPersistenceError("handoff receipt could not be persisted");
  }
}

export function forceHandoff(
  context: AgentContext,
  input: {
    reason: string;
    details: string;
    knowledgeSearchResults: Map<string, KnowledgeRecord>;
  },
): AgentRunResult {
  let receipt;
  try {
    receipt = context.supportStore.create({
      customer_id: context.customerId,
      session_id: context.sessionId,
      reason: input.reason,
      context: context.message.trim(),
      model_context: input.details,
      prior_actions: [...context.priorActions],
      idempotency_key: `${context.customerId}:${context.sessionId}:${context.requestId}:handoff`,
    });
  } catch (error) {
    if (error instanceof SupportRequestIdempotencyConflictError) {
      throw new HandoffIdempotencyConflictError("handoff_idempotency_conflict");
    }
    context.traceStore.recordToolEvent(
      context.traceId,
      "failed",
      "Harness-enforced handoff receipt failed",
    );
    throw new HandoffPersistenceError("handoff receipt could not be persisted");
  }
  context.traceStore.recordToolEvent(
    context.traceId,
    "completed",
    "Harness-enforced handoff receipt created",
  );
  return handoffResult(
    context,
    "业务无法安全完成，已创建可追踪的人工支持请求。",
    receipt.id,
    input.knowledgeSearchResults,
  );
}

export function completeAgentRun(
  context: AgentContext,
  input: {
    finalOutput: unknown;
    interrupted: boolean;
    attemptedToolNames: string[];
    knowledgeSearchResults: Map<string, KnowledgeRecord>;
  },
): AgentRunResult {
  if (input.interrupted) {
    context.priorActions.push("tool_permission:approval_required");
    return forceHandoff(context, {
      reason: "Harness 需要人工权限或授权",
      details: "Tool 权限边界中断了同步执行",
      knowledgeSearchResults: input.knowledgeSearchResults,
    });
  }
  if (typeof input.finalOutput !== "string" || !input.finalOutput.trim()) {
    return forceHandoff(context, {
      reason: "Harness 安全恢复已耗尽",
      details: "Agent 未返回可验证的客户结果",
      knowledgeSearchResults: input.knowledgeSearchResults,
    });
  }
  const finalOutput = input.finalOutput;
  if (
    input.attemptedToolNames.includes("create_handoff") &&
    context.supportRequestId === null
  ) {
    return forceHandoff(context, {
      reason: "Harness 强制升级",
      details: "create_handoff 调用失败或参数无效",
      knowledgeSearchResults: input.knowledgeSearchResults,
    });
  }
  if (context.supportRequestId !== null) {
    return handoffResult(
      context,
      finalOutput,
      context.supportRequestId,
      input.knowledgeSearchResults,
    );
  }
  if (
    input.knowledgeSearchResults.size > 0 &&
    ![...input.knowledgeSearchResults.values()].some((record) =>
      finalOutput.includes(record.source),
    )
  ) {
    throw new InvalidAgentOutputError(
      "Knowledge-backed reply omitted its source",
    );
  }
  const [businessOutcome, completionEvidence] = context.verifyBusinessOutcome();
  const error =
    completionEvidence?.split(":").slice(1).join(":") || "business_tool_failed";
  return {
    reply:
      businessOutcome === "not_completed"
        ? `业务操作未完成：${error}`
        : finalOutput,
    knowledge_search_results: [...input.knowledgeSearchResults.values()],
    memory_events: context.memoryEvents,
    business_outcome: businessOutcome,
    completion_evidence: completionEvidence,
    support_request_id: context.supportRequestId,
  };
}

export function persistAgentRun(
  context: AgentContext,
  result: AgentRunResult,
): AgentRunResult {
  context.traceStore.recordOutcome(context.traceId, {
    business_outcome: result.business_outcome,
    completion_evidence: result.completion_evidence,
    knowledge_sources: result.knowledge_search_results.map(
      (item) => item.source,
    ),
    memory_sources: result.memory_events.flatMap((event) =>
      event.memories.map((memory: CustomerMemory) => memory.source_id),
    ),
    support_request_id: result.support_request_id,
  });
  return result;
}

export function persistAgentFailure(
  traceStore: TraceStore,
  traceId: string,
  code: string,
): void {
  traceStore.recordError(traceId, code);
  traceStore.fail(traceId);
}

function handoffResult(
  context: AgentContext,
  reply: string,
  supportRequestId: string,
  knowledgeSearchResults: Map<string, KnowledgeRecord>,
): AgentRunResult {
  return {
    reply,
    knowledge_search_results: [...knowledgeSearchResults.values()],
    memory_events: context.memoryEvents,
    business_outcome: "not_completed",
    completion_evidence: `handoff:${supportRequestId}`,
    support_request_id: supportRequestId,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof ZodError) return "invalid_tool_input";
  return error instanceof Error ? error.message : String(error);
}
