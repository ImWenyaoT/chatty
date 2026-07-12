import type { AgentSessionStatus, AgentStepTerminality } from "./types.js";

/** Trace data deliberately remains extensible: it is an operator-facing debug surface. */
export type HarnessTrace = {
  sdk?: { runStatus?: string; outputValidated?: boolean; failureKind?: string };
  llm?: {
    model?: string;
    calls?: number;
    callBudget?: number;
    inputCacheHitTokens?: number;
    inputCacheMissTokens?: number;
    inputCacheHitRatio?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostCny?: number;
    operations?: string[];
    warnings?: string[];
  };
  task?: { kind?: string; goal?: string; terminality?: string };
  action?: {
    action?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
  };
  context?: {
    fragments?: Array<{ kind?: string; label?: string; content?: string }>;
  };
  toolCalls?: Array<{
    toolName?: string;
    risk?: string;
    approvalRequired?: boolean;
  }>;
  toolResults?: unknown[];
};

/** Successful payload returned by POST /api/playground. */
export type PlaygroundResponse = {
  reply: string;
  traceId: string;
  runId: string;
  sessionId: string;
  status: AgentSessionStatus;
  terminality: AgentStepTerminality;
  harnessTrace: HarnessTrace;
};

export type PlaygroundErrorCode =
  | "unauthorized"
  | "invalid_json"
  | "invalid_input"
  | "llm_not_configured"
  | "llm_provider_failed"
  | "workflow_conflict";

export type ApiErrorResponse = {
  error: PlaygroundErrorCode | "not_found" | "invalid_state_transition";
  issues?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Guards untrusted JSON before client code reads a successful playground payload. */
export function isPlaygroundResponse(
  value: unknown,
): value is PlaygroundResponse {
  return (
    isRecord(value) &&
    typeof value.reply === "string" &&
    typeof value.traceId === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.status === "string" &&
    typeof value.terminality === "string" &&
    isRecord(value.harnessTrace)
  );
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return isRecord(value) && typeof value.error === "string";
}
