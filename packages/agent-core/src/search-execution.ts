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
  question: string;
  productId?: string;
  searchedQueries: readonly string[];
  sessionStatus?: AgentSessionStatus;
  policy?: Policy;
  signal?: AbortSignal;
  onAttempt?: (call: RuntimeToolCall) => void;
};

/**
 * Executes one harness-owned knowledge search request. The module owns query
 * refinement, duplicate prevention, policy gating, and trace/context evidence;
 * SDK and low-level model adapters only pass search requests through this seam.
 */
export async function executeSearchRequest(
  input: SearchExecutionInput,
): Promise<SearchExecutionResult> {
  const query = readSearchQuery(input.input);
  if (input.toolName !== "search_knowledge" || !query) {
    return { kind: "retry", output: SEARCH_BAD_ARGS };
  }

  const refinedQuery = refineKnowledgeQuery(
    query,
    input.question,
    input.productId,
  );
  if (input.searchedQueries.includes(refinedQuery)) {
    return {
      kind: "retry",
      output: `已搜索过 ${refinedQuery}。请基于已有结果直接回答。`,
    };
  }

  const tool = input.registry.get(input.toolName);
  if (!tool) throw new Error(`tool not found: ${input.toolName}`);
  const toolCall: RuntimeToolCall = {
    toolName: input.toolName,
    arguments: { query: refinedQuery },
    risk: tool.risk,
    approvalRequired: tool.approvalRequired,
  };
  input.onAttempt?.(toolCall);
  const toolResult = await input.registry.invokeWithPolicy(
    input.toolName,
    { query: refinedQuery },
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
      label: `知识库检索：${refinedQuery}`,
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

/** 将模型给出的泛搜索词收敛到当前商品和用户问题，避免噪音词带偏 search_knowledge。 */
function refineKnowledgeQuery(
  query: string,
  question: string,
  productId?: string,
): string {
  const cleanQuery = query.trim();
  if (
    /不合身|换码|换货|换吗/.test(question) &&
    (/不合身|换码|换货|更换|售后/.test(cleanQuery) ||
      /^(规则|信息)$/.test(cleanQuery))
  )
    return "换码";
  if (
    /怎么租|如何租/.test(question) &&
    (/租赁流程|怎么租|如何租/.test(cleanQuery) ||
      /^(流程|规则|信息)$/.test(cleanQuery))
  )
    return "怎么租";
  if (
    /清洗|自己洗|洗吗|洗护/.test(question) &&
    (/清洗|洗护|穿完|处理/.test(cleanQuery) || /^(规则|信息)$/.test(cleanQuery))
  )
    return "清洗";
  if (!productId) return cleanQuery;
  if (cleanQuery.includes(productId)) return cleanQuery;
  if (
    /尺码|身高|体重|码|推荐/.test(question) &&
    /尺码|西装码|推荐|规则|信息|西装/.test(cleanQuery)
  ) {
    return `${productId} 尺码`;
  }
  if (/押金/.test(question) && /^(规则|信息|费用|商品规则)$/.test(cleanQuery)) {
    return "押金";
  }
  return cleanQuery;
}

function isPlainJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
