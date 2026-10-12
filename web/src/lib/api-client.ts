export class ApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ApiError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw new ApiError("network_error");
    throw error;
  }
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError("invalid_error_response");
    }
    let code = `http_${response.status}`;
    if (isRecord(body) && typeof body.detail === "string") {
      code = body.detail;
    }
    throw new ApiError(code);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("invalid_response");
  }
}

const postJson = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export type DemoUser = {
  id: string;
  label: string;
  display_name: string;
  profile_label: string;
};

export type CatalogInfo = {
  categories: string[];
  users: DemoUser[];
  product_count: number;
  model_id: string;
};

export type CatalogProduct = {
  product_id: string;
  name: string;
  category: string;
  price_cents: number;
  description: string;
  brand: string;
  seller_id: string;
  stock: number;
  tags: string[];
  popularity_score: number;
  image_url: string;
  source: string;
};

export type CatalogProfile = {
  user_id: string;
  segment: string;
  preferred_categories: string[];
  min_price_cents: number;
  max_price_cents: number;
  recent_views: string[];
  recent_purchases: string[];
  display_name: string;
  profile_label: string;
};

export type CatalogData = {
  products: CatalogProduct[];
  profiles: CatalogProfile[];
};

export type Session = { session_id: string };

export type RunUsage = {
  model_requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type Product = {
  product_id: string;
  name: string;
  category: string;
  price_cents: number;
  brand: string;
  stock: number;
  tags: string[];
  low_stock: boolean;
  reason: string;
  marketing_copy: string;
};

export type Turn = {
  understood_as: string;
  answer: string | null;
  latency_ms: number;
  turns_left: number;
  trace: string[];
  usage: RunUsage;
  kind: "answer" | "clarify" | "recommend" | "exhausted";
  question: string | null;
  products: Product[];
};

export const fetchCatalog = () => request<CatalogInfo>("/api/catalog");
export const fetchCatalogData = () => request<CatalogData>("/api/catalog/data");
export const createSession = (userId: string) =>
  postJson<Session>("/api/sessions", { user_id: userId });
export const takeTurn = (sessionId: string, text: string) =>
  postJson<Turn>(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
    text,
  });

const MESSAGES: Record<string, string> = {
  llm_not_configured: "没配 DEEPSEEK_API_KEY，后端连不上模型",
  invalid_recommendation: "已找到可售商品，但模型未返回有效推荐，已停止本轮",
  invalid_draft: "模型没有按约定返回完整结果，已停止本轮",
  duplicate_recommended_product: "模型重复推荐了同一商品，已停止本轮",
  recommended_product_out_of_stock: "商品在最终确认时已售罄，请重新查询",
  recommended_product_outside_price_range:
    "商品在最终确认时超出预算，请重新查询",
  required_tools_not_used: "模型跳过了必须调用的工具，被 Harness 拦下了",
  knowledge_not_retrieved: "没检索到支撑理由的知识，不允许凭空生成",
  profile_not_loaded: "用户画像没有成功读取，本轮已停止",
  product_not_recalled: "模型推荐了搜索结果之外的商品，被证据校验拦下了",
  inventory_not_checked: "推荐商品没有经过库存确认，被证据校验拦下了",
  product_not_grounded: "推荐商品缺少知识依据，被证据校验拦下了",
  conversation_exhausted: "这轮问得够多了，开一段新对话再试",
  session_not_found: "会话不在了，开一段新的",
  request_parse_failed: "没有可靠地理解这句话，请换一种说法再试",
  invalid_response: "后端响应格式不正确，请查看服务日志",
  invalid_error_response: "后端错误响应格式不正确，请查看服务日志",
  network_error: "连不上后端，请确认服务已经启动",
};

export const explain = (code: string) => MESSAGES[code] ?? code;
