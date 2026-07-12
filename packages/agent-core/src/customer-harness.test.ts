import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationEvent, MemorySnapshot } from "@rental/shared";
import {
  buildCustomerServiceContext,
  createCustomerServiceRunPolicy,
  createDefaultToolRegistry,
  runCustomerServiceHarnessStep,
  scheduleCustomerServiceTask,
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

test("scheduler maps complete rental context to availability", () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent("5月10到5月12，身高 179 体重 70kg，有 L 吗"),
    memory: memory(),
  });
  assert.equal(task.kind, "check_availability");
  assert.equal(task.terminality, "tool_then_continue");
  assert.deepEqual(task.requiredContext, [
    "productId",
    "rentalPeriod",
    "bodyMeasurements",
  ]);
});

test("run policies expose one bounded SDK tool strategy", () => {
  const cases = [
    ["collect_missing_info", [], "none", 1],
    ["answer_question", ["search_knowledge"], "search_knowledge", 4],
    ["check_availability", ["check_availability"], "check_availability", 3],
    ["handoff", ["create_handoff"], "create_handoff", 3],
    ["follow_up", ["schedule_followup"], "schedule_followup", 3],
  ] as const;
  for (const [kind, toolNames, toolChoice, maxTurns] of cases) {
    const policy = createCustomerServiceRunPolicy(
      {
        kind,
        goal: kind,
        requiredContext: [],
        risk: kind === "handoff" ? "medium" : "low",
        terminality: kind === "handoff" ? "handoff_and_wait" : "reply_and_wait",
      },
      { requireKnowledgeSearch: true },
    );
    assert.deepEqual(policy.toolNames, toolNames);
    assert.equal(policy.toolChoice, toolChoice);
    assert.equal(policy.maxTurns, maxTurns);
  }
});

test("answer tasks keep search optional unless facts require grounding", () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent("这款多少钱一天？"),
    memory: memory(),
  });
  assert.equal(createCustomerServiceRunPolicy(task).toolChoice, "auto");
  assert.equal(
    createCustomerServiceRunPolicy(task, { requireKnowledgeSearch: true })
      .toolChoice,
    "search_knowledge",
  );
});

test("scheduler routes safety, fact, link, period, and opening-hours turns", () => {
  const cases = [
    ["我要投诉，给我退款", "handoff"],
    ["西装押金规则是什么？", "answer_question"],
    ["就是当前链接这款吗", "answer_question"],
    ["5月9号到10号用", "collect_missing_info"],
    ["门店营业到几点？", "answer_question"],
    ["衣服穿完还需要我自己洗吗？", "answer_question"],
  ] as const;
  for (const [question, expected] of cases) {
    assert.equal(
      scheduleCustomerServiceTask({
        event: userEvent(question),
        memory: memory(),
      }).kind,
      expected,
      question,
    );
  }
});

test("missing product questions collect only the product", () => {
  const event = { ...userEvent("这款多少钱一天？"), productId: undefined };
  const task = scheduleCustomerServiceTask({
    event,
    memory: memory({ productId: undefined }),
  });
  assert.equal(task.kind, "collect_missing_info");
  assert.match(task.goal, /只询问款式或商品编号/);
  assert.match(task.goal, /不询问日期、身高或体重/);
});

test("body-memory recall is honest for absent, complete, and partial profiles", () => {
  const event = {
    ...userEvent("我身高体重多少来着？"),
    productId: undefined,
  };
  const absent = scheduleCustomerServiceTask({
    event,
    memory: memory({ productId: undefined }),
  });
  assert.match(absent.goal, /还没有记录身高体重/);

  const complete = scheduleCustomerServiceTask({
    event,
    memory: memory({
      productId: undefined,
      customerMemory: {
        summary: {
          bodyProfiles: [{ profileId: "default", heightCm: 178, weightKg: 70 }],
        },
      },
    }),
  });
  assert.equal(complete.kind, "answer_question");
  assert.match(complete.goal, /178/);
  assert.match(complete.goal, /70/);

  const partial = scheduleCustomerServiceTask({
    event,
    memory: memory({
      productId: undefined,
      customerMemory: {
        summary: { bodyProfiles: [{ profileId: "default", heightCm: 178 }] },
      },
    }),
  });
  assert.match(partial.goal, /身高 178/);
  assert.match(partial.goal, /体重还没有记录/);
});

test("clarification repairs do not expose tools", () => {
  const task = scheduleCustomerServiceTask({
    event: userEvent("没听懂"),
    memory: memory({
      recentMessages: [{ role: "assistant", content: "请提供身高体重" }],
    }),
  });
  assert.equal(task.kind, "collect_missing_info");
  assert.match(task.goal, /先道歉/);
  assert.match(task.goal, /换一种更简单的说法/);
  assert.deepEqual(createCustomerServiceRunPolicy(task).toolNames, []);
});

test("context builder keeps ordered inspectable fragments", () => {
  const event = userEvent("这款多少钱");
  const snapshot = memory({
    recentMessages: [{ role: "assistant", content: "上一轮回复" }],
  });
  const task = scheduleCustomerServiceTask({ event, memory: snapshot });
  const context = buildCustomerServiceContext({
    event,
    memory: snapshot,
    task,
  });
  assert.deepEqual(
    context.fragments.map((fragment) => fragment.kind),
    ["task", "user_message", "memory", "product"],
  );
  assert.match(context.prompt, /SUIT-001/);
});

test("the harness step has one required SDK lane and returns auditable trace", async () => {
  let toolChoice: string | undefined;
  const result = await runCustomerServiceHarnessStep({
    event: userEvent("这款多少钱一天？"),
    memory: memory(),
    registry: createDefaultToolRegistry(),
    sdkRunner: async (runtime) => {
      toolChoice = runtime.runPolicy.toolChoice;
      return {
        reply: "第一天租金 199 元。",
        action: { action: "answer_question", reply: "第一天租金 199 元。" },
        toolCalls: [],
        toolResults: [],
        outputValidated: true,
      };
    },
  });
  assert.equal(toolChoice, "search_knowledge");
  assert.equal(result.step.reply, "第一天租金 199 元。");
  assert.equal(result.trace.sdk?.outputValidated, true);
  assert.deepEqual(result.step.memoryPatch, {
    lastHarnessTask: "answer_question",
    lastHarnessAction: "answer_question",
  });
});
