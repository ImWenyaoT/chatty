import type { JsonValue, RuntimeTool } from '@rental/shared'

// Minimal inline catalog used by search/price stubs. Intentionally duplicated
// from catalog-stubs.ts to keep stubs independent and dependency-free; the real
// adapter (later) reads rag-service/config/catalog.yaml once at runtime.

interface StubProduct {
  id: string
  name: string
  dailyPrice: number
  renewalDailyPrice: number
  currency: string
  keywords: string[]
}

const PRODUCTS: StubProduct[] = [
  {
    id: 'SUIT-001',
    name: '黑色双排扣西装',
    dailyPrice: 199,
    renewalDailyPrice: 99.5,
    currency: 'CNY',
    keywords: ['西装', 'suit', '黑色', '双排扣', '正装'],
  },
]

/**
 * Coerces a JsonValue into a finite number, falling back when not numeric.
 */
function asNumber(v: JsonValue, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

// --- search_products(query) -------------------------------------------------

export const searchProductsTool: RuntimeTool<Record<string, JsonValue>, JsonValue> = {
  name: 'search_products',
  description: 'Search the product catalog by free-text query (name/keywords).',
  risk: 'low',
  approvalRequired: false,
  async execute(input) {
    const query = String(input.query ?? '').toLowerCase().trim()
    if (!query) return { query, matches: [] }
    const matches = PRODUCTS.filter((p) =>
      [p.id, p.name, ...p.keywords].some((k) => k.toLowerCase().includes(query)),
    ).map((p) => ({ id: p.id, name: p.name, dailyPrice: p.dailyPrice, currency: p.currency }))
    return { query, matches } as unknown as JsonValue
  },
}

// --- calculate_price(productId, rentalPeriod, quantity) ---------------------
// Pricing rule mirrors catalog.yaml pricingNote: day 1 full price, renewals
// half price, transit days do not count against the rental period.

export const calculatePriceTool: RuntimeTool<Record<string, JsonValue>, JsonValue> = {
  name: 'calculate_price',
  description: 'Quote a rental price: day 1 full price, renewal days half price.',
  risk: 'low',
  approvalRequired: false,
  async execute(input) {
    const productId = String(input.productId ?? '').toUpperCase()
    const product = PRODUCTS.find((p) => p.id === productId)
    if (!product) return { found: false, productId }
    const rentalPeriod = Math.max(1, Math.floor(asNumber(input.rentalPeriod, 1)))
    const quantity = Math.max(1, Math.floor(asNumber(input.quantity, 1)))
    const renewalDays = Math.max(0, rentalPeriod - 1)
    const perUnit = product.dailyPrice + renewalDays * product.renewalDailyPrice
    const total = perUnit * quantity
    return {
      found: true,
      productId,
      productName: product.name,
      currency: product.currency,
      rentalPeriod,
      quantity,
      perUnit,
      total,
      pricingNote: '第一天全价，续租半价，在途不算租期',
    } as unknown as JsonValue
  },
}
