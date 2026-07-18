import type { Db } from "./database.js";

export interface AvailabilityQuery {
  productId: string;
  size: string;
  quantity?: number;
  fulfillmentMode?: FulfillmentMode;
  startDate?: string;
  endDate?: string;
}

export interface AvailabilityResult extends AvailabilityQuery {
  available: boolean;
  availableQuantity: number;
  productName?: string;
}

export type FulfillmentMode = "rental" | "buyout";
export type OrderStatus = "pending" | "confirmed" | "cancelled";

export interface CommerceOrder {
  id: string;
  idempotencyKey: string;
  customerId: string;
  conversationId: string;
  productId: string;
  size: string;
  fulfillmentMode: FulfillmentMode;
  quantity: number;
  startDate?: string;
  endDate?: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export type CreateOrderInput = Omit<
  CommerceOrder,
  "status" | "createdAt" | "updatedAt"
>;

export interface CommerceRepository {
  checkAvailability(input: AvailabilityQuery): AvailabilityResult;
  createOrder(input: CreateOrderInput): CommerceOrder;
  getOrder(id: string): CommerceOrder | undefined;
  confirmOrder(id: string): CommerceOrder;
  cancelOrder(id: string): CommerceOrder;
  countConfirmedOrders(customerId: string): number;
}

/** Narrow SQLite business boundary consumed by the availability tool. */
export function createCommerceRepository(db: Db): CommerceRepository {
  const getOrder = (id: string): CommerceOrder | undefined => {
    const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as
      OrderRow | undefined;
    return row ? mapOrder(row) : undefined;
  };

  const checkAvailability = (input: AvailabilityQuery): AvailabilityResult => {
    const productId = input.productId.trim().toUpperCase();
    const size = input.size.trim().toUpperCase();
    const quantity = input.quantity ?? 1;
    const fulfillmentMode = input.fulfillmentMode ?? "rental";
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error("availability quantity must be a positive integer");
    }
    if (
      fulfillmentMode === "rental" &&
      ((input.startDate && !input.endDate) ||
        (!input.startDate && input.endDate))
    ) {
      throw new Error(
        "rental availability requires both startDate and endDate",
      );
    }
    const row = db
      .prepare(
        `SELECT products.name AS product_name, product_variants.quantity
         FROM products
         JOIN product_variants ON product_variants.product_id = products.id
         WHERE products.id = ? AND product_variants.size = ? AND products.active = 1`,
      )
      .get(productId, size) as
      { product_name: string; quantity: number } | undefined;
    let reserved = 0;
    if (
      row &&
      fulfillmentMode === "rental" &&
      input.startDate &&
      input.endDate
    ) {
      const reservation = db
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS quantity
           FROM orders
           WHERE product_id = ? AND size = ? AND status = 'confirmed'
             AND fulfillment_mode = 'rental'
             AND start_date < ? AND end_date > ?`,
        )
        .get(productId, size, input.endDate, input.startDate) as {
        quantity: number;
      };
      reserved = reservation.quantity;
    }
    const availableQuantity = Math.max(0, (row?.quantity ?? 0) - reserved);
    return {
      available: availableQuantity >= quantity,
      availableQuantity,
      productId,
      ...(row ? { productName: row.product_name } : {}),
      size,
      quantity,
      fulfillmentMode,
      ...(input.startDate ? { startDate: input.startDate } : {}),
      ...(input.endDate ? { endDate: input.endDate } : {}),
    };
  };

  return {
    checkAvailability,

    createOrder(input) {
      validateOrderInput(input);
      const existing = db
        .prepare("SELECT * FROM orders WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as OrderRow | undefined;
      if (existing) return mapOrder(existing);
      const ts = new Date().toISOString();
      db.prepare(
        `INSERT INTO orders
         (id, idempotency_key, customer_id, conversation_id, product_id, size,
          fulfillment_mode, quantity, start_date, end_date, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        input.id,
        input.idempotencyKey,
        input.customerId,
        input.conversationId,
        input.productId.trim().toUpperCase(),
        input.size.trim().toUpperCase(),
        input.fulfillmentMode,
        input.quantity,
        input.startDate ?? null,
        input.endDate ?? null,
        ts,
        ts,
      );
      return getOrder(input.id)!;
    },

    getOrder,

    confirmOrder(id) {
      return db.transaction(() => {
        const order = requireOrder(getOrder(id), id);
        if (order.status === "confirmed") return order;
        if (order.status !== "pending") {
          throw new Error(`cannot confirm ${order.status} order: ${id}`);
        }
        const availability = checkAvailability({
          productId: order.productId,
          size: order.size,
          quantity: order.quantity,
          fulfillmentMode: order.fulfillmentMode,
          startDate: order.startDate,
          endDate: order.endDate,
        });
        if (!availability.available)
          throw new Error(`insufficient inventory: ${id}`);
        if (order.fulfillmentMode === "buyout") {
          const update = db
            .prepare(
              `UPDATE product_variants SET quantity = quantity - ?
               WHERE product_id = ? AND size = ? AND quantity >= ?`,
            )
            .run(order.quantity, order.productId, order.size, order.quantity);
          if (update.changes !== 1)
            throw new Error(`insufficient inventory: ${id}`);
        }
        db.prepare(
          "UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?",
        ).run(new Date().toISOString(), id);
        return getOrder(id)!;
      })();
    },

    cancelOrder(id) {
      return db.transaction(() => {
        const order = requireOrder(getOrder(id), id);
        if (order.status === "cancelled") return order;
        if (
          order.status === "confirmed" &&
          order.fulfillmentMode === "buyout"
        ) {
          db.prepare(
            `UPDATE product_variants SET quantity = quantity + ?
             WHERE product_id = ? AND size = ?`,
          ).run(order.quantity, order.productId, order.size);
        }
        db.prepare(
          "UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?",
        ).run(new Date().toISOString(), id);
        return getOrder(id)!;
      })();
    },

    countConfirmedOrders(customerId) {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS count FROM orders WHERE customer_id = ? AND status = 'confirmed'",
        )
        .get(customerId) as { count: number };
      return row.count;
    },
  };
}

function validateOrderInput(input: CreateOrderInput): void {
  if (!input.productId.trim() || !input.size.trim())
    throw new Error("product and size are required");
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new Error("order quantity must be a positive integer");
  }
  if (
    input.fulfillmentMode === "rental" &&
    (!input.startDate || !input.endDate || input.startDate >= input.endDate)
  ) {
    throw new Error("rental order requires a valid date range");
  }
}

function requireOrder(
  order: CommerceOrder | undefined,
  id: string,
): CommerceOrder {
  if (!order) throw new Error(`order not found: ${id}`);
  return order;
}

interface OrderRow {
  id: string;
  idempotency_key: string;
  customer_id: string;
  conversation_id: string;
  product_id: string;
  size: string;
  fulfillment_mode: FulfillmentMode;
  quantity: number;
  start_date: string | null;
  end_date: string | null;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

function mapOrder(row: OrderRow): CommerceOrder {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    productId: row.product_id,
    size: row.size,
    fulfillmentMode: row.fulfillment_mode,
    quantity: row.quantity,
    ...(row.start_date ? { startDate: row.start_date } : {}),
    ...(row.end_date ? { endDate: row.end_date } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
