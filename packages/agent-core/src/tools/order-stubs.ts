import type { JsonValue, RuntimeTool } from '@rental/shared'

// Static MVP order data. Deterministic stubs so tests need no DB; a later step
// swaps in an order adapter behind the same RuntimeTool interface.

interface OrderLine {
  productId: string
  productName: string
  dailyPrice: number
  quantity: number
}

interface OrderRecord {
  orderNo: string
  customerId: string
  status: 'pending' | 'paid' | 'shipped' | 'returned' | 'closed' | 'refunded'
  totalAmount: number
  currency: string
  createdAt: string
  lines: OrderLine[]
}

const ORDERS: Record<string, OrderRecord> = {
  'ORD-1001': {
    orderNo: 'ORD-1001',
    customerId: 'c',
    status: 'shipped',
    totalAmount: 199,
    currency: 'CNY',
    createdAt: '2026-06-20T00:00:00.000Z',
    lines: [
      { productId: 'SUIT-001', productName: '黑色双排扣西装', dailyPrice: 199, quantity: 1 },
    ],
  },
}

/**
 * Returns all orders for a customer, used by get_order_history.
 */
function getOrdersByCustomer(customerId: string): OrderRecord[] {
  return Object.values(ORDERS).filter((o) => o.customerId === customerId)
}

// --- get_order_history(customerId) ------------------------------------------

export const getOrderHistoryTool: RuntimeTool<Record<string, JsonValue>, JsonValue> = {
  name: 'get_order_history',
  description: 'List a customer past orders, newest first.',
  risk: 'low',
  approvalRequired: false,
  async execute(input) {
    const customerId = String(input.customerId ?? '')
    const orders = getOrdersByCustomer(customerId).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    )
    return { found: orders.length > 0, customerId, orders } as unknown as JsonValue
  },
}

// --- get_order_status(orderNo) ----------------------------------------------

export const getOrderStatusTool: RuntimeTool<Record<string, JsonValue>, JsonValue> = {
  name: 'get_order_status',
  description: 'Lookup a single order by order number, including status and lines.',
  risk: 'low',
  approvalRequired: false,
  async execute(input) {
    const orderNo = String(input.orderNo ?? '').toUpperCase()
    const order = ORDERS[orderNo]
    if (!order) return { found: false, orderNo }
    return { found: true, ...order } as unknown as JsonValue
  },
}
