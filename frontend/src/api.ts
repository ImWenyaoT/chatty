/**
 * 后端接口的类型与调用。
 *
 * 这些类型是手写的，和后端 HTTP 响应模型一一对应。手写而不是
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
  users: CatalogUser[]
  product_count: number
  model_id: string
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

type Decoder<T> = (value: unknown) => T

const isRecord = (value: unknown): value is Record<string, unknown> => {
  // JavaScript 会把 null 也归类为 object，所以这里要单独排除。
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isStringArray = (value: unknown): value is string[] => {
  if (!Array.isArray(value)) return false
  return value.every((item) => typeof item === 'string')
}

const invalidResponse = (): never => {
  throw new ApiError('invalid_response')
}

const decodeProduct = (value: unknown): Product => {
  if (!isRecord(value)) return invalidResponse()

  const hasIdentity =
    typeof value.product_id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.category === 'string' &&
    typeof value.brand === 'string'
  if (!hasIdentity) return invalidResponse()

  const hasInventory =
    typeof value.price_cents === 'number' &&
    typeof value.stock === 'number' &&
    typeof value.low_stock === 'boolean'
  if (!hasInventory) return invalidResponse()

  const hasCopy =
    isStringArray(value.tags) &&
    typeof value.reason === 'string' &&
    typeof value.marketing_copy === 'string'
  if (!hasCopy) return invalidResponse()

  return value as unknown as Product
}

const decodeCatalogUser = (value: unknown): CatalogUser => {
  if (!isRecord(value)) return invalidResponse()
  if (typeof value.id !== 'string') return invalidResponse()
  if (typeof value.label !== 'string') return invalidResponse()
  return { id: value.id, label: value.label }
}

const decodeCatalog = (value: unknown): CatalogInfo => {
  if (!isRecord(value)) return invalidResponse()
  if (!isStringArray(value.categories)) return invalidResponse()
  if (!Array.isArray(value.users)) return invalidResponse()
  if (typeof value.product_count !== 'number') return invalidResponse()
  if (typeof value.model_id !== 'string') return invalidResponse()

  const users = value.users.map(decodeCatalogUser)
  return {
    categories: value.categories,
    users,
    product_count: value.product_count,
    model_id: value.model_id,
  }
}

const decodeSession = (value: unknown): { session_id: string } => {
  if (!isRecord(value)) return invalidResponse()
  if (typeof value.session_id !== 'string') return invalidResponse()
  return { session_id: value.session_id }
}

const decodeTurn = (value: unknown): Turn => {
  if (!isRecord(value)) return invalidResponse()

  const validKinds = ['recommend', 'clarify', 'exhausted']
  if (!validKinds.includes(String(value.kind))) return invalidResponse()
  if (typeof value.understood_as !== 'string') return invalidResponse()
  if (typeof value.question !== 'string' && value.question !== null) return invalidResponse()
  if (!Array.isArray(value.products)) return invalidResponse()
  if (typeof value.latency_ms !== 'number') return invalidResponse()
  if (typeof value.turns_left !== 'number') return invalidResponse()
  if (value.kind !== 'recommend' && !value.question) {
    return invalidResponse()
  }
  return {
    kind: value.kind as Turn['kind'],
    understood_as: value.understood_as,
    question: value.question,
    products: value.products.map(decodeProduct),
    latency_ms: value.latency_ms,
    turns_left: value.turns_left,
  }
}

async function request<T>(path: string, decode: Decoder<T>, init?: RequestInit): Promise<T> {
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
  // 第三类失败：请求成功，但响应形状和前端约定不一致。
  try {
    return decode(await response.json())
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error
    throw new ApiError('invalid_response')
  }
}

export const fetchCatalog = () => {
  return request('/api/catalog', decodeCatalog)
}

export const createSession = (userId: string) => {
  return request('/api/sessions', decodeSession, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })
}

export const takeTurn = (sessionId: string, text: string) => {
  return request(`/api/sessions/${sessionId}/turns`, decodeTurn, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

/** 错误码 → 人话。没收录的码原样显示，总比吞掉强。 */
const MESSAGES: Record<string, string> = {
  llm_not_configured: '没配 DEEPSEEK_API_KEY，后端连不上模型',
  invalid_recommendation: '条件太紧，目录里没有同时满足类目和价格的商品',
  invalid_draft: '模型没有按约定返回完整结果，已停止本轮',
  duplicate_recommended_product: '模型重复推荐了同一商品，已停止本轮',
  recommended_product_out_of_stock: '商品在最终确认时已售罄，请重新查询',
  recommended_product_outside_price_range: '商品在最终确认时超出预算，请重新查询',
  required_tools_not_used: '模型跳过了必须调用的工具，被 Harness 拦下了',
  knowledge_not_retrieved: '没检索到支撑理由的知识，不允许凭空生成',
  product_not_recalled: '模型推荐了搜索结果之外的商品，被证据校验拦下了',
  conversation_exhausted: '这轮问得够多了，开一段新对话再试',
  session_not_found: '会话不在了，开一段新的',
  need_parse_failed: '没有可靠地理解这句话，请换一种说法再试',
  invalid_response: '后端响应格式不正确，请查看服务日志',
  invalid_error_response: '后端错误响应格式不正确，请查看服务日志',
  network_error: '连不上后端，请确认服务已经启动',
}

export const explain = (code: string) => MESSAGES[code] ?? code
