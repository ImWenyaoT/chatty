import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommerceRepository, openDatabase } from "./index.js";

test("availability reads seeded product and size quantities from SQLite", () => {
  const commerce = createCommerceRepository(openDatabase(":memory:"));

  assert.deepEqual(
    commerce.checkAvailability({
      productId: "SUIT-001",
      size: "L",
      startDate: "2026-08-01",
      endDate: "2026-08-03",
    }),
    {
      available: true,
      availableQuantity: 2,
      productId: "SUIT-001",
      productName: "黑色双排扣西装",
      size: "L",
      quantity: 1,
      fulfillmentMode: "rental",
      startDate: "2026-08-01",
      endDate: "2026-08-03",
    },
  );
});

test("confirmed rentals reduce only overlapping availability and cancellation releases it", () => {
  const commerce = createCommerceRepository(openDatabase(":memory:"));
  const order = commerce.createOrder({
    id: "order-rental",
    idempotencyKey: "idem-rental",
    customerId: "customer-1",
    conversationId: "conversation-1",
    productId: "SUIT-001",
    size: "L",
    fulfillmentMode: "rental",
    quantity: 2,
    startDate: "2026-08-01",
    endDate: "2026-08-03",
  });
  commerce.confirmOrder(order.id);

  assert.equal(
    commerce.checkAvailability({
      productId: "SUIT-001",
      size: "L",
      quantity: 1,
      fulfillmentMode: "rental",
      startDate: "2026-08-02",
      endDate: "2026-08-04",
    }).available,
    false,
  );
  assert.equal(
    commerce.checkAvailability({
      productId: "SUIT-001",
      size: "L",
      quantity: 2,
      fulfillmentMode: "rental",
      startDate: "2026-08-04",
      endDate: "2026-08-06",
    }).available,
    true,
  );

  commerce.cancelOrder(order.id);
  assert.equal(
    commerce.checkAvailability({
      productId: "SUIT-001",
      size: "L",
      quantity: 2,
      fulfillmentMode: "rental",
      startDate: "2026-08-02",
      endDate: "2026-08-04",
    }).availableQuantity,
    2,
  );
});

test("confirmed buyout permanently reduces stock until cancellation", () => {
  const commerce = createCommerceRepository(openDatabase(":memory:"));
  const order = commerce.createOrder({
    id: "order-buyout",
    idempotencyKey: "idem-buyout",
    customerId: "customer-1",
    conversationId: "conversation-1",
    productId: "SUIT-001",
    size: "M",
    fulfillmentMode: "buyout",
    quantity: 1,
  });
  commerce.confirmOrder(order.id);
  assert.equal(
    commerce.checkAvailability({
      productId: "SUIT-001",
      size: "M",
      quantity: 1,
      fulfillmentMode: "buyout",
    }).available,
    false,
  );
  commerce.cancelOrder(order.id);
  assert.equal(
    commerce.checkAvailability({
      productId: "SUIT-001",
      size: "M",
      quantity: 1,
      fulfillmentMode: "buyout",
    }).available,
    true,
  );
});

test("order idempotency does not duplicate or oversell", () => {
  const commerce = createCommerceRepository(openDatabase(":memory:"));
  const input = {
    id: "order-first",
    idempotencyKey: "same-request",
    customerId: "customer-1",
    conversationId: "conversation-1",
    productId: "SUIT-001",
    size: "XL",
    fulfillmentMode: "buyout" as const,
    quantity: 1,
  };
  const first = commerce.createOrder(input);
  const replay = commerce.createOrder({ ...input, id: "order-second" });
  assert.equal(replay.id, first.id);
  commerce.confirmOrder(first.id);
  assert.throws(() =>
    commerce.confirmOrder(
      commerce.createOrder({
        ...input,
        id: "order-third",
        idempotencyKey: "different-request",
      }).id,
    ),
  );
  assert.equal(commerce.getOrder("order-third")?.status, "pending");
});

test("availability rejects an unknown product variant without inventing stock", () => {
  const commerce = createCommerceRepository(openDatabase(":memory:"));

  assert.deepEqual(
    commerce.checkAvailability({
      productId: "SUIT-001",
      size: "XXL",
      quantity: 1,
      fulfillmentMode: "rental",
      startDate: "2026-08-01",
      endDate: "2026-08-03",
    }),
    {
      available: false,
      availableQuantity: 0,
      productId: "SUIT-001",
      size: "XXL",
      quantity: 1,
      fulfillmentMode: "rental",
      startDate: "2026-08-01",
      endDate: "2026-08-03",
    },
  );
});
