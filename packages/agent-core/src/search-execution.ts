import type {
  AgentSessionStatus,
  JsonValue,
  RuntimeToolCall,
} from "@rental/shared";
import { createDefaultPolicy, type Policy } from "./policies/policy.js";
import type { CustomerServiceContextFragment } from "./customer-harness.js";
import type { ToolRegistry } from "./tools/registry.js";

const SEARCH_BAD_ARGS =
  "query 参数缺失或不是字符串，请重试，只需提供 query 一个参数";

export type SearchExecutionResult =
  | {
      kind: "executed";
      output: string;
      fragment: CustomerServiceContextFragment;
      toolCall: RuntimeToolCall;
      toolResult: JsonValue;
    }
  | {
      kind: "retry";
      output: string;
    };

export type SearchExecutionInput = {
  toolName: string;
  input: unknown;
  registry: ToolRegistry;
  searchedQueries: readonly string[];
  sessionStatus?: AgentSessionStatus;
  policy?: Policy;
  signal?: AbortSignal;
  onAttempt?: (call: RuntimeToolCall) => void;
};

/**
 * Executes one Model-selected knowledge search. This module owns argument
 * validation, duplicate prevention, policy gating, and trace/context evidence.
 */
export async function executeSearchRequest(
  input: SearchExecutionInput,
): Promise<SearchExecutionResult> {
  const query = readSearchQuery(input.input);
  if (input.toolName !== "search_knowledge" || !query) {
    return { kind: "retry", output: SEARCH_BAD_ARGS };
  }

  if (input.searchedQueries.includes(query)) {
    return {
      kind: "retry",
      output: `已搜索过 ${query}。请基于已有结果直接回答。`,
    };
  }

  const tool = input.registry.get(input.toolName);
  if (!tool) throw new Error(`tool not found: ${input.toolName}`);
  const toolCall: RuntimeToolCall = {
    toolName: input.toolName,
    arguments: { query },
    risk: tool.risk,
    approvalRequired: tool.approvalRequired,
  };
  input.onAttempt?.(toolCall);
  const toolResult = await input.registry.invokeWithPolicy(
    input.toolName,
    { query },
    input.policy ?? createDefaultPolicy(),
    { sessionStatus: input.sessionStatus ?? "active" },
    { signal: input.signal },
  );
  const output =
    isPlainJsonObject(toolResult) && typeof toolResult.output === "string"
      ? toolResult.output
      : JSON.stringify(toolResult);

  return {
    kind: "executed",
    output,
    fragment: {
      kind: "knowledge",
      label: `知识库检索：${query}`,
      content: output,
    },
    toolCall,
    toolResult,
  };
}

/** Extracts a search query from raw SDK/tool-loop input. */
export function readSearchQuery(input: unknown): string | undefined {
  let source = input;
  if (typeof input === "string") {
    try {
      source = JSON.parse(input) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isPlainJsonObject(source) || typeof source.query !== "string")
    return undefined;
  const query = source.query.trim();
  return query.length > 0 ? query : undefined;
}

function isPlainJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
