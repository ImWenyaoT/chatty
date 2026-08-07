/**
 * 把用户原话转换为简单、可校验的 ParsedRequest。
 *
 * 这个文件只负责“理解用户要做什么”，不搜索商品、不查库存、也不生成最终回复。
 * RequestParseOutput 是 Model 输出的临时形状；ParsedRequest 是 Harness 使用的领域对象。
 */

import {
  extractAllTextOutput,
  type RunErrorHandlerInput,
  type RunErrorHandlerResult,
} from "@openai/agents";

import type {
  ParsedRequest,
  ProductNeed,
  UserContext,
} from "../../data/models.ts";
import {
  emptyUserContext,
  parsedRequestSchema,
  productNeedSchema,
} from "../../data/models.ts";
import { round } from "../../data/round.ts";
import {
  requestParseOutputSchema,
  type RequestParser,
  type RequestParseOutput,
} from "../subagents/request_parser/agent.ts";

/** 模型返回的请求无法安全映射到当前业务数据。 */
export class RequestParseError extends Error {}

/** 兼容 DeepSeek 把 structured output 包在 properties 中的响应。 */
export function recoverInvalidRequest(
  data: RunErrorHandlerInput<unknown, RequestParser>,
): RunErrorHandlerResult<RequestParser> {
  const output = parseRequestOutput(
    extractAllTextOutput(data.runData.newItems),
  );
  return { finalOutput: output };
}

/** 只在 invalidFinalOutput 路径解开 DeepSeek 的 properties 包装。 */
export function parseRequestOutput(raw: string): RequestParseOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RequestParseError("invalid_request_parse_output");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestParseError("invalid_request_parse_output");
  }
  const properties = (value as Record<string, unknown>)["properties"];
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    throw new RequestParseError("invalid_request_parse_output");
  }
  const parsed = requestParseOutputSchema.safeParse(properties);
  if (!parsed.success)
    throw new RequestParseError("invalid_request_parse_output");
  return parsed.data;
}

/** 校验动态业务边界；不根据关键词在 Harness 中再次猜测语义。 */
export function parseRequest(
  output: RequestParseOutput,
  categories: readonly string[],
): ParsedRequest {
  const category = output.category?.trim() || null;
  const minYuan = output.min_yuan;
  const maxYuan = output.max_yuan;

  let productNeed: ProductNeed | null;
  if (output.product_requested) {
    if (category !== null && !categories.includes(category)) {
      throw new RequestParseError("invalid_product_category");
    }
    if (minYuan !== null && maxYuan !== null && minYuan > maxYuan) {
      throw new RequestParseError("invalid_product_price_range");
    }
    const need = productNeedSchema.safeParse({
      category,
      min_yuan: minYuan,
      max_yuan: maxYuan,
    });
    if (!need.success)
      throw new RequestParseError("invalid_product_price_range");
    productNeed = need.data;
  } else {
    if (category !== null || minYuan !== null || maxYuan !== null) {
      throw new RequestParseError("product_fields_without_request");
    }
    productNeed = null;
  }

  const knowledgeQuery = output.knowledge_query?.trim() || null;
  const parsed = parsedRequestSchema.safeParse({
    product_need: productNeed,
    knowledge_query: knowledgeQuery,
  });
  if (!parsed.success) throw new RequestParseError("empty_request");
  return parsed.data;
}

/** 把 ParsedRequest 中的商品需求转换为 Catalog 使用的搜索条件。 */
export function productContext(need: ProductNeed): UserContext {
  const context = emptyUserContext();
  if (need.category !== null) context.preferred_categories = [need.category];
  if (need.min_yuan !== null)
    context.min_price_cents = round(need.min_yuan * 100);
  if (need.max_yuan !== null)
    context.max_price_cents = round(need.max_yuan * 100);
  return context;
}

/** 把结构化请求转回简短中文，供 UI 展示“理解为”。 */
export function describeRequest(request: ParsedRequest): string {
  const parts: string[] = [];
  const need = request.product_need;
  if (need !== null) {
    parts.push(need.category || "不限类目");
    if (need.min_yuan !== null) parts.push(`≥${round(need.min_yuan)} 元`);
    if (need.max_yuan !== null) parts.push(`≤${round(need.max_yuan)} 元`);
  }
  if (request.knowledge_query) parts.push(`知识 · ${request.knowledge_query}`);
  return parts.join(" · ");
}
