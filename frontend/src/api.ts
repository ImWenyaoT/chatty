/**
 * 后端接口的类型与调用。
 *
 * 前后端在同一个 Demo 仓库中，共享一份人工维护的接口约定。
 */

/** 商品的全部字段都由后端从 SQLite 重查后给出，前端不做任何业务计算。 */
export interface Product {
  product_id: string
  name: string
  category: string
  price_cents: number
  brand: string
  stock: number
  tags: string[]
  low_stock: boolean
  reason: string
  marketing_copy: string
}

/** 一轮的结果。四种互斥情况，UI 按 kind 分支。 */
export interface Turn {
  kind: 'answer' | 'recommend' | 'clarify' | 'exhausted'
  understood_as: string
  answer: string | null
  question: string | null
  products: Product[]
  latency_ms: number
  turns_left: number
  trace: string[]
  usage: RunUsage
}

export interface RunUsage {
  model_requests: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface CatalogInfo {
  categories: string[]
  users: CatalogUser[]
  product_count: number
  model_id: string
}

export interface CatalogProduct {
  product_id: string
  name: string
  category: string
  price_cents: number
  description: string
  brand: string
  seller_id: string
  stock: number
  tags: string[]
  popularity_score: number
  source: string
}

export interface CatalogProfile {
  user_id: string
  segment: string
  display_name: string
  profile_label: string
  preferred_categories: string[]
  min_price_cents: number
  max_price_cents: number
  recent_views: string[]
  recent_purchases: string[]
}

export interface CatalogData {
  products: CatalogProduct[]
  profiles: CatalogProfile[]
}

interface CatalogUser {
  id: string
  label: string
}

/**
 * 带稳定错误码的失败。
 *
 * 后端的领域失败都有 code（condition 太紧、模型这轮没按约定走……），UI 靠它给出
 * 具体的解释，而不是笼统地说「出错了」。这是 Harness 的一部分，不该在前端丢掉。
 */
export class ApiError extends Error {
  // 写成普通字段而不是构造函数参数属性：tsconfig 开了 erasableSyntaxOnly，
  // 参数属性是需要转译的 TS 特有语法，不允许出现。
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'ApiError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 第一类失败：浏览器根本没有收到 HTTP 响应。
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  } catch (error: unknown) {
    if (error instanceof TypeError) throw new ApiError('network_error')
    throw error
  }
  if (!response.ok) {
    // 第二类失败：后端明确返回业务错误码。
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ApiError('invalid_error_response')
    }
    let code = `http_${response.status}`
    if (isRecord(body) && typeof body.detail === 'string') {
      code = body.detail
    }
    throw new ApiError(code)
  }
  // JSON 损坏仍明确报错；字段契约由同仓的 FastAPI 与 TypeScript 类型共同维护。
  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError('invalid_response')
  }
}

export const fetchCatalog = () => {
  return request<CatalogInfo>('/api/catalog')
}

export const fetchCatalogData = () => {
  return request<CatalogData>('/api/catalog/data')
}

export const createSession = (userId: string) => {
  return request<{ session_id: string }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })
}

export const takeTurn = (sessionId: string, text: string) => {
  return request<Turn>(`/api/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

/** 错误码 → 人话。没收录的码原样显示，总比吞掉强。 */
const MESSAGES: Record<string, string> = {
  llm_not_configured: '没配 DEEPSEEK_API_KEY，后端连不上模型',
  invalid_recommendation: '已找到可售商品，但模型未返回有效推荐，已停止本轮',
  invalid_draft: '模型没有按约定返回完整结果，已停止本轮',
  duplicate_recommended_product: '模型重复推荐了同一商品，已停止本轮',
  recommended_product_out_of_stock: '商品在最终确认时已售罄，请重新查询',
  recommended_product_outside_price_range: '商品在最终确认时超出预算，请重新查询',
  required_tools_not_used: '模型跳过了必须调用的工具，被 Harness 拦下了',
  knowledge_not_retrieved: '没检索到支撑理由的知识，不允许凭空生成',
  profile_not_loaded: '用户画像没有成功读取，本轮已停止',
  product_not_recalled: '模型推荐了搜索结果之外的商品，被证据校验拦下了',
  inventory_not_checked: '推荐商品没有经过库存确认，被证据校验拦下了',
  product_not_grounded: '推荐商品缺少知识依据，被证据校验拦下了',
  conversation_exhausted: '这轮问得够多了，开一段新对话再试',
  session_not_found: '会话不在了，开一段新的',
  task_frame_parse_failed: '没有可靠地理解这句话，请换一种说法再试',
  invalid_response: '后端响应格式不正确，请查看服务日志',
  invalid_error_response: '后端错误响应格式不正确，请查看服务日志',
  network_error: '连不上后端，请确认服务已经启动',
}

export const explain = (code: string) => MESSAGES[code] ?? code
