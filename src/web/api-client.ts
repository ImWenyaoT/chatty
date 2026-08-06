/**
 * HTTP 客户端：把 `app/api/**` 的 5 个端点包成带稳定错误码的函数。
 *
 * 迁到 Next.js 之后没有了 Hono RPC 的端到端类型推导，响应类型在这里显式声明，
 * 形状复用 `data/models.ts` 的领域类型——契约的真相仍然只有一份，只是从
 * 「路由推导」换成了「领域模型 + 路由各自引用同一批类型」。
 * 字段名保持 snake_case，与 SQLite 列名和 HTTP 契约一致。
 */
import type { DEMO_USERS } from "../data/demo-users.ts";
import type {
  Product as DomainProduct,
  RecommendedProduct,
  UserProfile,
} from "../data/models.ts";

/**
 * 带稳定错误码的失败。
 *
 * 后端的领域失败都有 code（condition 太紧、模型这轮没按约定走……），UI 靠它给出
 * 具体的解释，而不是笼统地说「出错了」。这是 Harness 的一部分，不该在前端丢掉。
 */
export class ApiError extends Error {
  // 写成普通字段而不是构造函数参数属性：tsconfig 开了 erasableSyntaxOnly，
  // 参数属性是需要转译的 TS 特有语法，不允许出现。
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ApiError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    // 第一类失败：请求根本没到后端。fetch 只在网络层失败时抛 TypeError。
    response = await fetch(path, init);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw new ApiError("network_error");
    throw error;
  }
  if (!response.ok) {
    // 第二类失败：后端明确返回业务错误码。
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

const postJson = <T>(path: string, body: unknown) => {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

/** `GET /api/catalog`：启动时的一次性概览。 */
export type DemoUser = (typeof DEMO_USERS)[number];

export type CatalogInfo = {
  categories: string[];
  users: DemoUser[];
  product_count: number;
  model_id: string;
};

/** `GET /api/catalog/data`：数据页的只读快照。 */
export type CatalogProduct = DomainProduct;
export type CatalogProfile = UserProfile & {
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

export type Product = RecommendedProduct;

/**
 * `POST /api/sessions/{id}/turns`：一轮的完整观察面。
 *
 * 四种 kind 共用同一组字段，不用的位置由后端填 null / 空数组——前端不再自行推导，
 * 也不需要按 kind 拆成判别联合。
 */
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

export const fetchCatalog = () => {
  return request<CatalogInfo>("/api/catalog");
};

export const fetchCatalogData = () => {
  return request<CatalogData>("/api/catalog/data");
};

export const createSession = (userId: string) => {
  return postJson<Session>("/api/sessions", { user_id: userId });
};

export const takeTurn = (sessionId: string, text: string) => {
  return postJson<Turn>(
    `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
    { text },
  );
};

/** 错误码 → 人话。没收录的码原样显示，总比吞掉强。 */
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
  task_frame_parse_failed: "没有可靠地理解这句话，请换一种说法再试",
  invalid_response: "后端响应格式不正确，请查看服务日志",
  invalid_error_response: "后端错误响应格式不正确，请查看服务日志",
  network_error: "连不上后端，请确认服务已经启动",
};

export const explain = (code: string) => MESSAGES[code] ?? code;
