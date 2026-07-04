import type { JsonValue, RuntimeTool } from '@rental/shared'

// Static MVP product catalog mirroring rag-service/config/catalog.yaml.
// Kept inline so the tool stubs are deterministic and dependency-free; a later
// step can replace this with a catalog adapter that reads the YAML at runtime.

interface ProductCatalogEntry {
  id: string
  name: string
  dailyPrice: number
  renewalDailyPrice: number
  currency: string
  shippingPolicy: string
  pricingNote: string
}

const PRODUCTS: Record<string, ProductCatalogEntry> = {
  'SUIT-001': {
    id: 'SUIT-001',
    name: '黑色双排扣西装',
    dailyPrice: 199,
    renewalDailyPrice: 99.5,
    currency: 'CNY',
    shippingPolicy: '寄出包邮，新疆、西藏等偏远地区除外',
    pricingNote: '第一天全价，续租半价，在途不算租期',
  },
}

function getProduct(id: string): ProductCatalogEntry | undefined {
  return PRODUCTS[id.toUpperCase()]
}

function jsonResult(value: JsonValue): JsonValue {
  return value
}

// --- get_product(productId) -------------------------------------------------

export const getProductTool: RuntimeTool<Record<string, JsonValue>, JsonValue> = {
  name: 'get_product',
  description: 'Lookup a product by id. Returns name, price, currency, shipping and pricing notes.',
  risk: 'low',
  approvalRequired: false,
  async execute(input) {
    const id = String(input.productId ?? '')
    const product = getProduct(id)
    if (!product) {
      return jsonResult({ found: false, productId: id })
    }
    return jsonResult({ found: true, ...product })
  },
}

// --- check_availability(productId, size, rentalPeriod) ----------------------
// Stub (mirrors rag-service availability-service.ts which always returns
// available). Real inventory replaces this behind the same interface.

export const checkAvailabilityTool: RuntimeTool<Record<string, JsonValue>, JsonValue> = {
  name: 'check_availability',
  description: 'Check whether a product/size is available for a rental period.',
  risk: 'low',
  approvalRequired: false,
  async execute(input) {
    const productId = String(input.productId ?? '')
    const size = String(input.size ?? 'L')
    const product = getProduct(productId)
    if (!product) {
      return jsonResult({ available: false, reason: 'unknown_product', productId })
    }
    return jsonResult({ available: true, productId, size, suggestedSize: 'L' })
  },
}
