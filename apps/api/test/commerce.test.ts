import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CommerceError,
  CommerceStore,
  type CreateOrderInput,
} from "../src/commerce.js";

function rentalOrder(
  overrides: Partial<CreateOrderInput> = {},
): CreateOrderInput {
  return {
    idempotency_key: "session-1:create-1",
    customer_id: "customer-1",
    session_id: "session-1",
    product_id: "SUIT-001",
    size: "L",
    fulfillment_mode: "rental",
    quantity: 2,
    start_date: "2026-08-01",
    end_date: "2026-08-03",
    amount_cents: 76_000,
    channel: "Chatty",
    address: "上海市静安区",
    risk: "无",
    ...overrides,
  };
}

function withStore(run: (store: CommerceStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "chatty-commerce-"));
  const store = new CommerceStore(join(directory, "chatty.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertCommerceError(operation: () => unknown, code: string): void {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof CommerceError, true);
    assert.equal((error as CommerceError).code, code);
    return true;
  });
}

test("confirmed rental reserves only overlapping dates and cancellation releases it", () => {
  withStore((store) => {
    const order = store.createOrder(rentalOrder());
    store.confirmOrder(order.id);

    assert.equal(
      store.checkAvailability({
        product_id: "SUIT-001",
        size: "L",
        quantity: 1,
        fulfillment_mode: "rental",
        start_date: "2026-08-02",
        end_date: "2026-08-04",
      }).available,
      false,
    );
    assert.equal(
      store.checkAvailability({
        product_id: "SUIT-001",
        size: "L",
        quantity: 2,
        fulfillment_mode: "rental",
        start_date: "2026-08-03",
        end_date: "2026-08-05",
      }).available,
      true,
    );

    store.cancelOrder(order.id);
    assert.equal(
      store.checkAvailability({
        product_id: "SUIT-001",
        size: "L",
        quantity: 2,
        fulfillment_mode: "rental",
        start_date: "2026-08-02",
        end_date: "2026-08-04",
      }).available,
      true,
    );
    assert.deepEqual(
      store.getOrder(order.id).events.map((event) => event.event_type),
      ["created", "confirmed", "cancelled"],
    );
  });
});

test("buyout confirmation decrements stock once and cancellation restores once", () => {
  withStore((store) => {
    const order = store.createOrder(
      rentalOrder({
        idempotency_key: "session-1:buy-1",
        fulfillment_mode: "buyout",
        size: "M",
        quantity: 1,
        start_date: null,
        end_date: null,
      }),
    );

    assert.equal(store.confirmOrder(order.id).status, "confirmed");
    assert.equal(store.confirmOrder(order.id).status, "confirmed");
    assert.equal(
      store.checkAvailability({
        product_id: "SUIT-001",
        size: "M",
        quantity: 1,
        fulfillment_mode: "buyout",
      }).available_quantity,
      0,
    );

    assert.equal(store.cancelOrder(order.id).status, "cancelled");
    assert.equal(store.cancelOrder(order.id).status, "cancelled");
    assert.equal(
      store.checkAvailability({
        product_id: "SUIT-001",
        size: "M",
        quantity: 1,
        fulfillment_mode: "buyout",
      }).available_quantity,
      1,
    );
    assert.deepEqual(
      store.getOrder(order.id).events.map((event) => event.event_type),
      ["created", "confirmed", "cancelled"],
    );
  });
});

test("create is idempotent and failures preserve the pending state", () => {
  withStore((store) => {
    const first = store.createOrder(rentalOrder());
    const replay = store.createOrder(rentalOrder());
    assert.equal(replay.id, first.id);
    assert.equal(store.listOrders().length, 1);

    assertCommerceError(
      () => store.createOrder(rentalOrder({ quantity: 1 })),
      "idempotency_conflict",
    );
    assert.equal(store.listOrders().length, 1);

    assertCommerceError(
      () =>
        store.createOrder(
          rentalOrder({ idempotency_key: "unknown", size: "XXL" }),
        ),
      "unknown_variant",
    );

    const tooLarge = store.createOrder(
      rentalOrder({ idempotency_key: "too-large", quantity: 3 }),
    );
    assertCommerceError(
      () => store.confirmOrder(tooLarge.id),
      "insufficient_inventory",
    );
    assert.equal(store.getOrder(tooLarge.id).status, "pending");
  });
});
