import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { OrderSchema, type Order, type OrderEvent } from "@chatty/contracts";
import { z } from "zod";
import {
  integer,
  nullableText,
  type SqliteRow as Row,
  text,
} from "./sqlite-row.js";

export const CreateOrderInputSchema = z
  .object({
    idempotency_key: z.string().min(1).max(200),
    customer_id: z.string().min(1).max(200),
    session_id: z.string().min(1).max(200),
    product_id: z.string().min(1).max(100),
    size: z.string().min(1).max(40),
    fulfillment_mode: z.enum(["rental", "buyout"]),
    quantity: z.number().int().min(1).max(100),
    start_date: z.string().nullable().default(null),
    end_date: z.string().nullable().default(null),
    amount_cents: z.number().int().positive(),
    channel: z.string().min(1).max(100).default("Chatty"),
    address: z.string().min(1).max(500),
    risk: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((order, context) => {
    if (order.fulfillment_mode === "rental") {
      if (
        order.start_date === null ||
        order.end_date === null ||
        order.start_date >= order.end_date
      ) {
        context.addIssue({ code: "custom", message: "invalid_rental_period" });
      }
    } else if (order.start_date !== null || order.end_date !== null) {
      context.addIssue({
        code: "custom",
        message: "buyout_does_not_accept_dates",
      });
    }
  });

export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;
export type FulfillmentMode = CreateOrderInput["fulfillment_mode"];
export type OrderStatus = Order["status"];

export type Availability = {
  product_id: string;
  product_name: string;
  size: string;
  fulfillment_mode: FulfillmentMode;
  requested_quantity: number;
  available_quantity: number;
  available: boolean;
};

export class CommerceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CommerceError";
  }
}

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS product_variants (
    product_id TEXT NOT NULL,
    size TEXT NOT NULL,
    stock INTEGER NOT NULL CHECK (stock >= 0),
    PRIMARY KEY (product_id, size),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    customer_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    size TEXT NOT NULL,
    fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('rental', 'buyout')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    start_date TEXT,
    end_date TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    risk TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (product_id, size) REFERENCES product_variants(product_id, size)
);

CREATE INDEX IF NOT EXISTS idx_orders_availability
    ON orders (product_id, size, status, fulfillment_mode, start_date, end_date);

CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'confirmed', 'cancelled')),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (order_id, event_type),
    FOREIGN KEY (order_id) REFERENCES orders(id)
);
`;

function timestamp(): string {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000+00:00");
}

export class CommerceStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(schema);
    this.database
      .prepare("INSERT OR IGNORE INTO products (id, name) VALUES (?, ?)")
      .run("SUIT-001", "黑色双排扣西装");
    const seedVariant = this.database.prepare(
      "INSERT OR IGNORE INTO product_variants (product_id, size, stock) VALUES (?, ?, ?)",
    );
    for (const [size, stock] of [
      ["M", 1],
      ["L", 2],
      ["XL", 1],
    ] as const) {
      seedVariant.run("SUIT-001", size, stock);
    }
  }

  close(): void {
    this.database.close();
  }

  checkAvailability(input: {
    product_id: string;
    size: string;
    quantity: number;
    fulfillment_mode: FulfillmentMode;
    start_date?: string | null;
    end_date?: string | null;
  }): Availability {
    const startDate = input.start_date ?? null;
    const endDate = input.end_date ?? null;
    if (input.quantity < 1) throw new CommerceError("invalid_quantity");
    if (input.fulfillment_mode === "rental") {
      if (startDate === null || endDate === null || startDate >= endDate) {
        throw new CommerceError("invalid_rental_period");
      }
    } else if (startDate !== null || endDate !== null) {
      throw new CommerceError("buyout_does_not_accept_dates");
    }

    const productId = input.product_id.trim().toUpperCase();
    const size = input.size.trim().toUpperCase();
    const variant = this.database
      .prepare(
        `SELECT products.name, product_variants.stock
         FROM product_variants
         JOIN products ON products.id = product_variants.product_id
         WHERE product_variants.product_id = ? AND product_variants.size = ?
           AND products.active = 1`,
      )
      .get(productId, size) as Row | undefined;
    if (variant === undefined) throw new CommerceError("unknown_variant");

    let reserved = 0;
    if (input.fulfillment_mode === "rental") {
      const row = this.database
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS reserved
           FROM orders
           WHERE product_id = ? AND size = ? AND status = 'confirmed'
             AND fulfillment_mode = 'rental'
             AND start_date < ? AND end_date > ?`,
        )
        .get(productId, size, endDate, startDate) as Row;
      reserved = integer(row, "reserved");
    }
    const availableQuantity = Math.max(0, integer(variant, "stock") - reserved);
    return {
      product_id: productId,
      product_name: text(variant, "name"),
      size,
      fulfillment_mode: input.fulfillment_mode,
      requested_quantity: input.quantity,
      available_quantity: availableQuantity,
      available: availableQuantity >= input.quantity,
    };
  }

  createOrder(rawInput: CreateOrderInput): Order {
    const input = CreateOrderInputSchema.parse(rawInput);
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT id FROM orders WHERE idempotency_key = ?")
        .get(input.idempotency_key) as Row | undefined;
      if (existing !== undefined) {
        const replay = this.getOrder(text(existing, "id"));
        if (!sameCreateOrder(replay, input)) {
          throw new CommerceError("idempotency_conflict");
        }
        return replay;
      }

      this.checkAvailability(input);
      const orderId = `order_${randomUUID().replaceAll("-", "")}`;
      const now = timestamp();
      this.database
        .prepare(
          `INSERT INTO orders (
             id, idempotency_key, customer_id, session_id, product_id, size,
             fulfillment_mode, quantity, start_date, end_date, amount_cents,
             status, channel, address, risk, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          orderId,
          input.idempotency_key,
          input.customer_id,
          input.session_id,
          input.product_id.trim().toUpperCase(),
          input.size.trim().toUpperCase(),
          input.fulfillment_mode,
          input.quantity,
          input.start_date,
          input.end_date,
          input.amount_cents,
          input.channel,
          input.address,
          input.risk,
          now,
          now,
        );
      this.recordEvent(orderId, "created", "订单已创建", now);
      return this.getOrder(orderId);
    });
  }

  confirmOrder(orderId: string): Order {
    return this.transaction(() => {
      const order = this.getOrder(orderId);
      if (order.status === "confirmed") return order;
      if (order.status !== "pending") {
        throw new CommerceError("order_not_confirmable");
      }
      const availability = this.checkAvailability(order);
      if (!availability.available)
        throw new CommerceError("insufficient_inventory");
      if (order.fulfillment_mode === "buyout") {
        const result = this.database
          .prepare(
            `UPDATE product_variants SET stock = stock - ?
             WHERE product_id = ? AND size = ? AND stock >= ?`,
          )
          .run(order.quantity, order.product_id, order.size, order.quantity);
        if (Number(result.changes) !== 1) {
          throw new CommerceError("insufficient_inventory");
        }
      }
      const now = timestamp();
      this.database
        .prepare(
          "UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?",
        )
        .run(now, orderId);
      this.recordEvent(orderId, "confirmed", "订单已确认", now);
      return this.getOrder(orderId);
    });
  }

  cancelOrder(orderId: string): Order {
    return this.transaction(() => {
      const order = this.getOrder(orderId);
      if (order.status === "cancelled") return order;
      if (order.status === "confirmed" && order.fulfillment_mode === "buyout") {
        this.database
          .prepare(
            `UPDATE product_variants SET stock = stock + ?
             WHERE product_id = ? AND size = ?`,
          )
          .run(order.quantity, order.product_id, order.size);
      }
      const now = timestamp();
      this.database
        .prepare(
          "UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?",
        )
        .run(now, orderId);
      this.recordEvent(orderId, "cancelled", "订单已取消", now);
      return this.getOrder(orderId);
    });
  }

  getOrder(orderId: string): Order {
    const row = this.database
      .prepare(
        `SELECT orders.*, products.name AS product_name
         FROM orders JOIN products ON products.id = orders.product_id
         WHERE orders.id = ?`,
      )
      .get(orderId) as Row | undefined;
    if (row === undefined) throw new CommerceError("order_not_found");
    const events = this.database
      .prepare(
        `SELECT id, event_type, description, created_at
         FROM order_events WHERE order_id = ? ORDER BY id`,
      )
      .all(orderId) as Row[];
    return OrderSchema.parse({
      id: text(row, "id"),
      customer_id: text(row, "customer_id"),
      session_id: text(row, "session_id"),
      product_id: text(row, "product_id"),
      product_name: text(row, "product_name"),
      size: text(row, "size"),
      fulfillment_mode: text(row, "fulfillment_mode"),
      quantity: integer(row, "quantity"),
      start_date: nullableText(row, "start_date"),
      end_date: nullableText(row, "end_date"),
      amount_cents: integer(row, "amount_cents"),
      status: text(row, "status"),
      channel: text(row, "channel"),
      address: text(row, "address"),
      risk: text(row, "risk"),
      created_at: text(row, "created_at"),
      updated_at: text(row, "updated_at"),
      events: events.map(
        (event) =>
          ({
            id: integer(event, "id"),
            event_type: text(event, "event_type"),
            description: text(event, "description"),
            created_at: text(event, "created_at"),
          }) satisfies Record<keyof OrderEvent, unknown>,
      ),
    });
  }

  listOrders(): Order[] {
    const rows = this.database
      .prepare("SELECT id FROM orders ORDER BY updated_at DESC, id DESC")
      .all() as Row[];
    return rows.map((row) => this.getOrder(text(row, "id")));
  }

  statusCounts(): Record<OrderStatus, number> {
    const counts: Record<OrderStatus, number> = {
      pending: 0,
      confirmed: 0,
      cancelled: 0,
    };
    const rows = this.database
      .prepare("SELECT status, COUNT(*) AS count FROM orders GROUP BY status")
      .all() as Row[];
    for (const row of rows) {
      const status = text(row, "status") as OrderStatus;
      counts[status] = integer(row, "count");
    }
    return counts;
  }

  private recordEvent(
    orderId: string,
    eventType: OrderEvent["event_type"],
    description: string,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO order_events
           (order_id, event_type, description, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(orderId, eventType, description, createdAt);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function sameCreateOrder(order: Order, requested: CreateOrderInput): boolean {
  return (
    order.customer_id === requested.customer_id &&
    order.session_id === requested.session_id &&
    order.product_id === requested.product_id.trim().toUpperCase() &&
    order.size === requested.size.trim().toUpperCase() &&
    order.fulfillment_mode === requested.fulfillment_mode &&
    order.quantity === requested.quantity &&
    order.start_date === requested.start_date &&
    order.end_date === requested.end_date &&
    order.amount_cents === requested.amount_cents &&
    order.channel === requested.channel &&
    order.address === requested.address &&
    order.risk === requested.risk
  );
}
