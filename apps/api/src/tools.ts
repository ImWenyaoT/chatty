import { z } from "zod";
import { unicodeCaseFold } from "./unicode.js";
import type { KnowledgeRecord, MemoryEvent, Order } from "@chatty/contracts";
import { CommerceError } from "./commerce.js";
import { AgentContext, createHandoff } from "./harness.js";
import { KnowledgeStore } from "./knowledge.js";

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
export const availabilityInput = z
  .object({
    product_id: z.string(),
    size: z.string(),
    fulfillment_mode: z.enum(["rental", "buyout"]),
    quantity: z.number().int(),
    start_date: isoDate,
    end_date: isoDate,
  })
  .strict();
export const createOrderToolInput = z
  .object({
    idempotency_key: z.string().min(1).max(200),
    product_id: z.string().min(1).max(100),
    size: z.string().min(1).max(40),
    fulfillment_mode: z.enum(["rental", "buyout"]),
    quantity: z.number().int().min(1).max(100),
    start_date: isoDate,
    end_date: isoDate,
    amount_cents: z.number().int().positive(),
    channel: z.string().min(1).max(100).default("Chatty"),
    address: z.string().min(1).max(500),
    risk: z.string().min(1).max(500),
  })
  .strict();
export const orderIdInput = z.object({ order_id: z.string() }).strict();
export const searchKnowledgeInput = z
  .object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(5).default(3),
  })
  .strict();
export const searchMemoryInput = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export const saveMemoryInput = z
  .object({
    fact: z.string().trim().min(1).max(500),
    explicitly_stated: z.literal(true),
    stable: z.literal(true),
  })
  .strict();
export const handoffInput = z
  .object({ reason: z.string(), context: z.string() })
  .strict();
export const saveResearchArtifactInput = z
  .object({
    idempotency_key: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    summary: z.string().min(1).max(2_000),
    claims: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            text: z.string().min(1).max(2_000),
            source_ids: z.array(z.string().min(1).max(200)).min(1).max(10),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            label: z.string().min(1).max(200),
            kind: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(30),
    relations: z
      .array(
        z
          .object({
            from: z.string().min(1).max(100),
            to: z.string().min(1).max(100),
            type: z.string().min(1).max(100),
            claim_id: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(60),
    unknowns: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();
export const saveContentArtifactInput = z
  .object({
    idempotency_key: z.string().min(1).max(200),
    research_artifact_id: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    channels: z
      .array(
        z
          .object({
            channel: z.enum(["xiaohongshu", "douyin", "wechat"]),
            title: z.string().min(1).max(500),
            body: z.string().min(1).max(10_000),
            claim_ids: z.array(z.string().min(1).max(100)).min(1).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export const exportArtifactInput = z
  .object({
    artifact_id: z.string().min(1).max(200),
    target: z.literal("sandbox"),
  })
  .strict();

export const chattyToolNames = [
  "search_knowledge",
  "search_customer_memory",
  "save_customer_memory",
  "check_availability",
  "create_order",
  "view_order",
  "confirm_order",
  "cancel_order",
  "create_handoff",
  "save_research_artifact",
  "save_content_artifact",
  "export_artifact",
] as const;

export type ChattyToolName = (typeof chattyToolNames)[number];

export type ToolExecutionState = {
  knowledgeSearchResults: Map<string, KnowledgeRecord>;
};

export function executeChattyTool(
  context: AgentContext,
  knowledgeStore: KnowledgeStore,
  state: ToolExecutionState,
  toolName: ChattyToolName,
  rawArguments: unknown,
): string {
  if (toolName === "search_knowledge") {
    const input = searchKnowledgeInput.parse(rawArguments);
    const result = knowledgeStore.search(input.query, input.limit);
    context.priorActions.push(`search_knowledge:${result.status}`);
    for (const record of result.results)
      state.knowledgeSearchResults.set(record.id, record);
    return JSON.stringify(result);
  }
  if (toolName === "search_customer_memory") {
    try {
      const input = searchMemoryInput.parse(rawArguments);
      const memories = context.memoryStore.search(
        context.customerId,
        input.query,
        input.limit,
      );
      const event: MemoryEvent = { tool: toolName, memories };
      context.memoryEvents.push(event);
      context.priorActions.push(`${toolName}:ok`);
      return JSON.stringify(event);
    } catch (error) {
      context.priorActions.push(`${toolName}:failed`);
      throw error;
    }
  }
  if (toolName === "save_customer_memory") {
    try {
      const input = saveMemoryInput.parse(rawArguments);
      if (
        !unicodeCaseFold(context.message).includes(unicodeCaseFold(input.fact))
      ) {
        throw new Error(
          "memory fact must be a verbatim part of the customer message",
        );
      }
      const memory = context.memoryStore.save(
        context.customerId,
        input.fact,
        context.traceId,
      );
      const event: MemoryEvent = { tool: toolName, memories: [memory] };
      context.memoryEvents.push(event);
      context.priorActions.push(`${toolName}:ok`);
      return JSON.stringify(event);
    } catch (error) {
      context.priorActions.push(`${toolName}:failed`);
      throw error;
    }
  }
  if (toolName === "create_handoff") {
    const input = handoffInput.parse(rawArguments);
    return JSON.stringify(createHandoff(context, input.reason, input.context));
  }
  if (toolName === "save_research_artifact") {
    try {
      const input = saveResearchArtifactInput.parse(rawArguments);
      for (const claim of input.claims) {
        for (const sourceId of claim.source_ids) {
          if (!state.knowledgeSearchResults.has(sourceId)) {
            throw new Error(`artifact_source_not_searched:${sourceId}`);
          }
        }
      }
      const artifact = context.artifacts.createResearch({
        ...input,
        idempotency_key: `${context.sessionId}:${input.idempotency_key}`,
        owner_id: context.customerId,
        session_id: context.sessionId,
      });
      const review = context.artifacts.review(artifact.id);
      const reviewed = context.artifacts.get(artifact.id);
      if (!review.passed) {
        throw new Error(`artifact_review_failed:${review.errors.join(",")}`);
      }
      context.recordArtifactSuccess(toolName, reviewed.id, reviewed.status);
      return success({ artifact: reviewed, review });
    } catch (error) {
      context.recordFailure(toolName, error);
      return failure(error);
    }
  }
  if (toolName === "save_content_artifact") {
    try {
      const input = saveContentArtifactInput.parse(rawArguments);
      const artifact = context.artifacts.createContent({
        ...input,
        idempotency_key: `${context.sessionId}:${input.idempotency_key}`,
        owner_id: context.customerId,
        session_id: context.sessionId,
      });
      const review = context.artifacts.review(artifact.id);
      const reviewed = context.artifacts.get(artifact.id);
      if (!review.passed) {
        throw new Error(`artifact_review_failed:${review.errors.join(",")}`);
      }
      context.recordArtifactSuccess(toolName, reviewed.id, reviewed.status);
      return success({ artifact: reviewed, review });
    } catch (error) {
      context.recordFailure(toolName, error);
      return failure(error);
    }
  }
  if (toolName === "export_artifact") {
    try {
      const input = exportArtifactInput.parse(rawArguments);
      const delivery = context.artifacts.export(
        input.artifact_id,
        input.target,
        context.customerId,
      );
      context.recordDeliverySuccess(
        toolName,
        delivery.id,
        delivery.content_hash,
      );
      return success({ delivery });
    } catch (error) {
      context.recordFailure(toolName, error);
      return failure(error);
    }
  }

  try {
    if (toolName === "check_availability") {
      const input = availabilityInput.parse(rawArguments);
      const availability = context.commerce.checkAvailability(input);
      context.recordReadSuccess(
        toolName,
        `${toolName}:${availability.product_id}:${availability.size}:available=${availability.available_quantity}`,
      );
      return success({ availability });
    }
    if (toolName === "create_order") {
      const input = createOrderToolInput.parse(rawArguments);
      const order = context.commerce.createOrder({
        ...input,
        idempotency_key: `${context.sessionId}:${input.idempotency_key}`,
        customer_id: context.customerId,
        session_id: context.sessionId,
      });
      context.recordOrderSuccess(toolName, order);
      return success({ order });
    }
    const input = orderIdInput.parse(rawArguments);
    const existing = customerOrder(context, input.order_id);
    if (toolName === "view_order") {
      context.recordReadSuccess(
        toolName,
        `${toolName}:${existing.id}:${existing.status}`,
      );
      return success({ order: existing });
    }
    const order =
      toolName === "confirm_order"
        ? context.commerce.confirmOrder(existing.id)
        : context.commerce.cancelOrder(existing.id);
    context.recordOrderSuccess(toolName, order);
    return success({ order });
  } catch (error) {
    context.recordFailure(toolName, error);
    return failure(error);
  }
}

function customerOrder(context: AgentContext, orderId: string): Order {
  const order = context.commerce.getOrder(orderId);
  if (order.customer_id !== context.customerId)
    throw new CommerceError("order_not_found");
  return order;
}

function success(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload });
}

function failure(error: unknown): string {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
