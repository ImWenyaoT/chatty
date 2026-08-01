/**
 * 后端接口的类型与调用。
 *
 * 这些类型是手写的，和 src/chatty/api.py 里的 pydantic 模型一一对应。手写而不是
 * 生成，是因为只有三个端点、四个模型——生成器要引一整套工具链，维护成本比抄一遍高。
 * 端点一改这里会跟着改，改漏了 UI 上立刻看得见。
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
  score: number
  low_stock: boolean
  reason: string
  marketing_copy: string
}

/** 一轮的结果。三种互斥情况，UI 按 kind 分支。 */
export interface Turn {
  kind: 'recommend' | 'clarify' | 'exhausted'
  understood_as: string
  question: string | null
  products: Product[]
  latency_ms: number
  turns_left: number
}

export interface CatalogInfo {
  categories: string[]
  users: string[]
  product_count: number
  model_id: string
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    // FastAPI 的 detail 可能是字符串（我们抛的领域码），也可能是校验错误数组
    const body = await response.json().catch(() => null)
    const detail = body?.detail
    throw new ApiError(typeof detail === 'string' ? detail : `http_${response.status}`)
  }
  return response.json() as Promise<T>
}

export const fetchCatalog = () => request<CatalogInfo>('/api/catalog')

export const createSession = (userId: string) =>
  request<{ session_id: string; user_id: string }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })

export const takeTurn = (sessionId: string, text: string) =>
  request<Turn>(`/api/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })

/** 错误码 → 人话。没收录的码原样显示，总比吞掉强。 */
const MESSAGES: Record<string, string> = {
  llm_not_configured: '没配 OPENAI_API_KEY，后端连不上模型',
  invalid_recommendation: '条件太紧，目录里没有同时满足类目和价格的商品',
  recommendation_failed: '模型这轮没按约定走，重试一次通常就好',
  required_tools_not_used: '模型跳过了必须调用的工具，被 Harness 拦下了',
  knowledge_not_retrieved: '没检索到支撑理由的知识，不允许凭空生成',
  product_not_recalled: '模型推荐了搜索结果之外的商品，被证据校验拦下了',
  conversation_exhausted: '这轮问得够多了，开一段新对话再试',
  session_not_found: '会话不在了，开一段新的',
}

export const explain = (code: string) => MESSAGES[code] ?? code
