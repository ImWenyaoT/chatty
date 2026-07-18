import type { JsonValue, RuntimeTool } from "@rental/shared";

export interface AvailabilityChecker {
  checkAvailability(input: {
    productId: string;
    size: string;
    quantity?: number;
    fulfillmentMode?: "rental" | "buyout";
    startDate?: string;
    endDate?: string;
  }): JsonValue | Promise<JsonValue>;
}

export interface CommerceToolBackend extends AvailabilityChecker {
  createOrder?(
    input: Record<string, JsonValue>,
  ): JsonValue | Promise<JsonValue>;
  confirmOrder?(
    input: Record<string, JsonValue>,
  ): JsonValue | Promise<JsonValue>;
  cancelOrder?(
    input: Record<string, JsonValue>,
  ): JsonValue | Promise<JsonValue>;
}

/** Adapts the local business system to the bounded Harness tool contract. */
export function createCheckAvailabilityTool(
  commerce: AvailabilityChecker,
): RuntimeTool<Record<string, JsonValue>, JsonValue> {
  return {
    name: "check_availability",
    description:
      "Check SQLite-backed availability for a product, size, and rental period.",
    risk: "low",
    approvalRequired: false,
    async execute(input) {
      return await commerce.checkAvailability({
        productId: String(input.productId ?? ""),
        size: String(input.size ?? ""),
        quantity: Number(input.quantity ?? 1),
        ...(input.fulfillmentMode === "rental" ||
        input.fulfillmentMode === "buyout"
          ? { fulfillmentMode: input.fulfillmentMode }
          : {}),
        ...(typeof input.startDate === "string"
          ? { startDate: input.startDate }
          : {}),
        ...(typeof input.endDate === "string"
          ? { endDate: input.endDate }
          : {}),
      });
    },
  };
}

function createCommerceMutationTool(
  name: "create_order" | "confirm_order" | "cancel_order",
  execute: (input: Record<string, JsonValue>) => JsonValue | Promise<JsonValue>,
): RuntimeTool<Record<string, JsonValue>, JsonValue> {
  return {
    name,
    description: `${name} through the transactional SQLite business system.`,
    risk: "low",
    approvalRequired: false,
    async execute(input) {
      return await execute(input);
    },
  };
}

export function createCommerceMutationTools(
  commerce: CommerceToolBackend,
): RuntimeTool<Record<string, JsonValue>, JsonValue>[] {
  return [
    ...(commerce.createOrder
      ? [createCommerceMutationTool("create_order", commerce.createOrder)]
      : []),
    ...(commerce.confirmOrder
      ? [createCommerceMutationTool("confirm_order", commerce.confirmOrder)]
      : []),
    ...(commerce.cancelOrder
      ? [createCommerceMutationTool("cancel_order", commerce.cancelOrder)]
      : []),
  ];
}
