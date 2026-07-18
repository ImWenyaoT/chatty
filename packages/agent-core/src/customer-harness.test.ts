import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationEvent, MemorySnapshot } from "@rental/shared";
import {
  buildCustomerServiceContext,
  createCustomerServiceSdkRunner,
  createDefaultToolRegistry,
  runCustomerServiceHarnessStep,
} from "./index.js";

function userEvent(
  question: string,
  productId: string | undefined = "SUIT-001",
): ConversationEvent {
  return {
    eventId: "evt_1",
    type: "user_message",
    customerId: "c",
    conversationId: "c:SUIT-001",
    productId,
    source: "customer",
    payload: { question },
    occurredAt: "2026-07-03T00:00:00.000Z",
    traceId: "tr_1",
  };
}

function memory(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    customerId: "c",
    conversationId: "c:SUIT-001",
    productId: "SUIT-001",
    recentMessages: [],
    ...overrides,
  };
}

test("context exposes user, memory, and product facts without preclassifying intent", () => {
  const context = buildCustomerServiceContext({
    event: userEvent("我身高体重多少来着？"),
    memory: memory({
      recentMessages: [{ role: "assistant", content: "上一轮回复" }],
      customerMemory: {
        bodyProfiles: [{ profileId: "default", heightCm: 178, weightKg: 70 }],
      },
    }),
  });

  assert.deepEqual(
    context.fragments.map((fragment) => fragment.kind),
    ["user_message", "memory", "product"],
  );
  assert.doesNotMatch(context.prompt, /当前客服任务|当前工具策略/);
  assert.match(context.prompt, /178/);
  assert.match(context.prompt, /SUIT-001/);
});

test("the harness returns the model-selected task as an auditable outcome", async () => {
  const sdkRunner = createCustomerServiceSdkRunner((options) => async () => {
    assert.equal(options.toolChoice, "auto");
    assert.doesNotMatch(options.input, /当前客服任务|当前工具策略/);
    assert.match(options.input, /五月十日至十二日是否可预订大码/);
    assert.deepEqual(options.tools.map((tool) => tool.name).sort(), [
      "check_availability",
      "create_handoff",
      "request_customer_information",
      "schedule_followup",
      "search_knowledge",
    ]);
    const availability = options.tools.find(
      (tool) => tool.name === "check_availability",
    );
    assert.ok(availability);
    await availability.execute({
      size: "L",
      startDate: "2026-05-10",
      endDate: "2026-05-12",
    });
    return { reply: "L 码这几天有货，可以继续下单。" };
  });

  const result = await runCustomerServiceHarnessStep({
    event: userEvent("SUIT-001 在五月十日至十二日是否可预订大码？"),
    memory: memory(),
    registry: createDefaultToolRegistry({ search: () => [] }, undefined, {
      checkAvailability: (input) => ({ ...input, available: true }),
    }),
    sdkRunner,
  });

  assert.equal(result.trace.task.kind, "check_availability");
  assert.equal(result.trace.action.action, "check_availability");
  assert.equal(result.step.nextStatus, "waiting_for_user");
  assert.deepEqual(result.step.memoryPatch, {
    lastHarnessTask: "check_availability",
    lastHarnessAction: "check_availability",
  });
});

test("missing information becomes a model-selected waiting-for-customer action", async () => {
  const sdkRunner = createCustomerServiceSdkRunner((options) => async () => {
    const request = options.tools.find(
      (tool) => tool.name === "request_customer_information",
    );
    assert.ok(request);
    await request.execute({
      message: "请告诉我想租的商品编号。",
      missingFields: ["productId"],
    });
    return { reply: "请告诉我想租的商品编号。" };
  });

  const result = await runCustomerServiceHarnessStep({
    event: userEvent("我想租一套西装", undefined),
    memory: memory({ productId: undefined }),
    registry: createDefaultToolRegistry(),
    sdkRunner,
  });

  assert.equal(result.trace.task.kind, "collect_missing_info");
  assert.equal(result.trace.action.action, "ask_missing_info");
  assert.equal(result.step.nextStatus, "waiting_for_user");
});

test("human in the loop creates a traceable handoff instead of an empty instruction", async () => {
  const sdkRunner = createCustomerServiceSdkRunner((options) => async () => {
    const handoff = options.tools.find(
      (tool) => tool.name === "create_handoff",
    );
    assert.ok(handoff);
    await handoff.execute({
      reason: "退款争议需要负责人处理",
      context: "客户要求核对订单 ORD-1001 的退款状态",
    });
    return { reply: "已创建退款处理工单，负责人会接续处理。" };
  });

  const result = await runCustomerServiceHarnessStep({
    event: userEvent("订单 ORD-1001 的退款一直没到账"),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    sdkRunner,
  });

  assert.equal(result.trace.action.action, "handoff");
  assert.equal(result.step.nextStatus, "waiting_for_human");
  assert.deepEqual(result.trace.toolResults[0], {
    ok: true,
    handoffId: "HO-c:SUIT-001",
    conversationId: "c:SUIT-001",
    reason: "退款争议需要负责人处理",
    context: "客户要求核对订单 ORD-1001 的退款状态",
    createdAt: "2026-06-26T00:00:00.000Z",
  });
});

test("a direct answer remains an answer task when no business tool is needed", async () => {
  const result = await runCustomerServiceHarnessStep({
    event: userEvent("你好"),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    sdkRunner: async () => ({
      reply: "你好，请问想处理什么问题？",
      action: {
        action: "answer_question",
        reply: "你好，请问想处理什么问题？",
      },
      toolCalls: [],
      toolResults: [],
      outputValidated: true,
    }),
  });

  assert.equal(result.trace.task.kind, "answer_question");
  assert.equal(result.step.reply, "你好，请问想处理什么问题？");
  assert.equal(result.trace.sdk?.outputValidated, true);
});
