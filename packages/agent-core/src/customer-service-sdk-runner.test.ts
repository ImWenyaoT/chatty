import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationEvent, MemorySnapshot } from "@rental/shared";
import { createDefaultPolicy } from "./policies/policy.js";
import {
  createCustomerServiceSdkRunner,
  type SdkStructuredRunFactory,
} from "./customer-service-sdk-runner.js";
import type { CustomerServiceSdkRunner } from "./customer-harness.js";
import { createDefaultToolRegistry } from "./tools/registry.js";

function runtime(
  question = "4月29到30号，L码有货吗",
): Parameters<CustomerServiceSdkRunner>[0] {
  const event = {
    eventId: "e-1",
    type: "user_message",
    customerId: "cust-1",
    conversationId: "conv-1",
    productId: "SUIT-001",
    source: "customer",
    payload: { question },
    occurredAt: "2026-04-01T00:00:00.000Z",
  } as ConversationEvent;
  const memory = {
    customerId: "cust-1",
    conversationId: "conv-1",
    productId: "SUIT-001",
    recentMessages: [],
  } as MemorySnapshot;
  return {
    context: {
      fragments: [
        { kind: "user_message", label: "用户本轮消息", content: question },
        { kind: "product", label: "商品上下文", content: "productId=SUIT-001" },
      ],
      prompt: `## 用户本轮消息\n${question}\n\n## 商品上下文\nproductId=SUIT-001`,
    },
    event,
    memory,
    registry: createDefaultToolRegistry(
      {
        search: (query) => [
          { section: `${query} 参考`, text: "第一天 199 元；建议 L 码" },
        ],
      },
      undefined,
      {
        checkAvailability: (input) => ({ ...input, available: true }),
      },
    ),
    sessionStatus: "active",
    policy: createDefaultPolicy(),
  };
}

test("the model can select availability and the harness injects trusted ids", async () => {
  const fakeRun: SdkStructuredRunFactory = (options) => async () => {
    assert.equal(options.toolChoice, "auto");
    const availability = options.tools.find(
      (tool) => tool.name === "check_availability",
    );
    assert.ok(availability);
    await availability.execute({
      size: "L",
      startDate: "2026-04-29",
      endDate: "2026-04-30",
    });
    return { reply: "L 码这两天有货，可以下单。" };
  };

  const result = await createCustomerServiceSdkRunner(fakeRun)(runtime());

  assert.equal(result.action.action, "check_availability");
  assert.deepEqual(result.toolCalls[0].arguments, {
    size: "L",
    quantity: 1,
    fulfillmentMode: "rental",
    startDate: "2026-04-29",
    endDate: "2026-04-30",
    productId: "SUIT-001",
  });
  assert.equal(result.toolResults.length, 1);
});

test("order tools receive trusted customer, conversation, product, and request ids", async () => {
  const current = runtime("L 码买断一件");
  current.registry = createDefaultToolRegistry(undefined, undefined, {
    checkAvailability: () => ({ available: true }),
    createOrder: (input) => ({ ok: true, orderId: "order-1", ...input }),
  });
  const result = await createCustomerServiceSdkRunner((options) => async () => {
    const create = options.tools.find((tool) => tool.name === "create_order");
    assert.ok(create);
    await create.execute({
      size: "L",
      quantity: 1,
      fulfillmentMode: "buyout",
      startDate: null,
      endDate: null,
    });
    return { reply: "买断订单已创建。" };
  })(current);

  assert.equal(result.action.action, "manage_order");
  assert.deepEqual(result.toolCalls[0].arguments, {
    size: "L",
    quantity: 1,
    fulfillmentMode: "buyout",
    startDate: null,
    endDate: null,
    productId: "SUIT-001",
    customerId: "cust-1",
    conversationId: "conv-1",
    requestId: "e-1",
  });
});

test("knowledge search uses the model query and records evidence once", async () => {
  const current = runtime("这款多少钱一天？");
  const events: string[] = [];
  current.emitEvent = (type) => events.push(type);
  const fakeRun: SdkStructuredRunFactory = (options) => async () => {
    const search = options.tools.find(
      (tool) => tool.name === "search_knowledge",
    );
    assert.ok(search);
    const first = await search.execute({ query: "SUIT-001 价格" });
    const duplicate = await search.execute({ query: "SUIT-001 价格" });
    assert.match(JSON.stringify(first), /199 元/);
    assert.match(String(duplicate), /已搜索过/);
    return { reply: "这款第一天 199 元。" };
  };

  const result = await createCustomerServiceSdkRunner(fakeRun)(current);

  assert.equal(result.action.action, "answer_question");
  assert.deepEqual(
    result.toolCalls.map((call) => call.arguments),
    [{ query: "SUIT-001 价格" }],
  );
  assert.equal(
    current.context.fragments.find((fragment) => fragment.kind === "knowledge")
      ?.label,
    "知识库检索：SUIT-001 价格",
  );
  assert.deepEqual(events, [
    "model_called",
    "tool_attempted",
    "tool_completed",
  ]);
});

test("requesting missing information is an explicit harness action", async () => {
  const fakeRun: SdkStructuredRunFactory = (options) => async () => {
    const request = options.tools.find(
      (tool) => tool.name === "request_customer_information",
    );
    assert.ok(request);
    await request.execute({
      message: "请提供商品编号。",
      missingFields: ["productId"],
    });
    return { reply: "请提供商品编号。" };
  };

  const result = await createCustomerServiceSdkRunner(fakeRun)(
    runtime("我想租衣服"),
  );
  assert.equal(result.action.action, "ask_missing_info");
  assert.equal(result.toolCalls[0].toolName, "request_customer_information");
});

test("a cancelled search is audited before execution stops", async () => {
  const current = runtime("尺码怎么选？");
  current.signal = AbortSignal.abort(new Error("search cancelled"));
  const events: string[] = [];
  current.emitEvent = (type) => events.push(type);
  const fakeRun: SdkStructuredRunFactory = (options) => async () => {
    const search = options.tools.find(
      (tool) => tool.name === "search_knowledge",
    );
    assert.ok(search);
    await search.execute({ query: "SUIT-001 尺码" });
    return { reply: "unreachable" };
  };

  await assert.rejects(
    createCustomerServiceSdkRunner(fakeRun)(current),
    /search cancelled/,
  );
  assert.deepEqual(events, ["model_called", "tool_attempted"]);
});

test("a denied tool call becomes a Harness-enforced Handoff", async () => {
  const current = runtime("押金规则是什么？");
  current.sessionStatus = "closed";
  const fakeRun: SdkStructuredRunFactory = (options) => async () => {
    const search = options.tools.find(
      (tool) => tool.name === "search_knowledge",
    );
    assert.ok(search);
    await search.execute({ query: "押金" });
    return { reply: "我已经查过了。" };
  };

  const result = await createCustomerServiceSdkRunner(fakeRun)(current);
  assert.equal(result.action.action, "handoff");
  assert.equal(result.toolCalls.at(-1)?.toolName, "create_handoff");
});

test("a business-tool failure is converted into one Harness-enforced Handoff", async () => {
  const current = runtime("查一下库存");
  let persisted = false;
  current.registry = createDefaultToolRegistry(
    undefined,
    {
      createHandoff: (input) => {
        persisted = true;
        return { ok: true, taskId: "task-human", ...input };
      },
    },
    {
      checkAvailability: () => {
        throw new Error("inventory unavailable");
      },
    },
  );
  const result = await createCustomerServiceSdkRunner((options) => async () => {
    const availability = options.tools.find(
      (tool) => tool.name === "check_availability",
    );
    assert.ok(availability);
    await availability.execute({
      size: "L",
      quantity: 1,
      fulfillmentMode: "rental",
      startDate: "2026-08-01",
      endDate: "2026-08-02",
    });
    return { reply: "库存系统暂不可用，已创建人工处理任务。" };
  })(current);

  assert.equal(result.action.action, "handoff");
  assert.equal(result.toolCalls.at(-1)?.toolName, "create_handoff");
  assert.equal(persisted, true);
});

test("only registered bounded business tools are exposed", async () => {
  const current = runtime();
  current.registry = createDefaultToolRegistry();
  const runner = createCustomerServiceSdkRunner((options) => async () => {
    assert.deepEqual(options.tools.map((tool) => tool.name).sort(), [
      "create_handoff",
      "request_customer_information",
      "schedule_followup",
    ]);
    return { reply: "请告诉我想处理什么问题。" };
  });

  await runner(current);
});
