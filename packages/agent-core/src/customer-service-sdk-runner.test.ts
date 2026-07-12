import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationEvent, MemorySnapshot } from "@rental/shared";
import {
  actionForTask,
  buildSdkPrompt,
  createCustomerServiceSdkRunner,
  type SdkStructuredRunFactory,
} from "./customer-service-sdk-runner.js";
import {
  createCustomerServiceRunPolicy,
  type CustomerServiceSdkRunner,
  type CustomerServiceTask,
} from "./customer-harness.js";
import { createDefaultToolRegistry } from "./tools/registry.js";
import { createDefaultPolicy } from "./policies/policy.js";

test("buildSdkPrompt renders task first, then tool policy, then dynamic context", () => {
  const runtime = {
    context: {
      fragments: [
        {
          kind: "task",
          label: "当前客服任务",
          content: "answer_question: 回答问题",
        },
        { kind: "user_message", label: "用户本轮消息", content: "押金多少" },
      ],
    },
    runPolicy: { toolNames: ["search_knowledge"], toolChoice: "auto" },
  } as unknown as Parameters<typeof buildSdkPrompt>[0];

  const blocks = buildSdkPrompt(runtime).split("\n\n");
  // 稳定顺序（cache-friendly）：task → 工具策略 → 动态片段。
  assert.equal(blocks[0], "## 当前客服任务\nanswer_question: 回答问题");
  assert.equal(
    blocks[1],
    "## 当前工具策略\n允许工具：search_knowledge\n工具选择：auto",
  );
  assert.equal(blocks[2], "## 用户本轮消息\n押金多少");
});

test("buildSdkPrompt marks an empty tool pool as 无", () => {
  const runtime = {
    context: {
      fragments: [
        {
          kind: "task",
          label: "当前客服任务",
          content: "collect_missing_info: 收集信息",
        },
      ],
    },
    runPolicy: { toolNames: [], toolChoice: "none" },
  } as unknown as Parameters<typeof buildSdkPrompt>[0];

  assert.match(buildSdkPrompt(runtime), /允许工具：无\n工具选择：none/);
});

test("actionForTask maps every scheduled task kind to its auditable action", () => {
  assert.equal(actionForTask("collect_missing_info"), "ask_missing_info");
  assert.equal(actionForTask("answer_question"), "answer_question");
  assert.equal(actionForTask("check_availability"), "check_availability");
  assert.equal(actionForTask("handoff"), "handoff");
  assert.equal(actionForTask("follow_up"), "schedule_followup");
});

/** Builds a check_availability runtime around the real registry/policy for the runner. */
function checkAvailabilityRuntime(): Parameters<CustomerServiceSdkRunner>[0] {
  const task: CustomerServiceTask = {
    kind: "check_availability",
    goal: "查库存",
    terminality: "tool_then_continue",
    requiredContext: [],
    risk: "low",
  };
  return {
    task,
    runPolicy: createCustomerServiceRunPolicy(task),
    context: {
      fragments: [
        { kind: "task", label: "当前客服任务", content: "check_availability" },
      ],
      prompt: "",
    },
    event: {
      eventId: "e-1",
      type: "user_message",
      customerId: "cust-1",
      conversationId: "conv-1",
      productId: "SUIT-001",
      source: "customer",
      payload: { question: "4月29到30号，L码有货吗" },
      occurredAt: "2026-04-01T00:00:00.000Z",
    } as ConversationEvent,
    memory: {
      customerId: "cust-1",
      conversationId: "conv-1",
      productId: "SUIT-001",
      recentMessages: [],
    } as MemorySnapshot,
    registry: createDefaultToolRegistry(),
    sessionStatus: "active",
    policy: createDefaultPolicy(),
  };
}

test("createCustomerServiceSdkRunner assembles tools, injects ids, and maps the audit action", async () => {
  // 假注入：模拟模型调用唯一工具后给出回复；不触网络、不启 SDK。
  const fakeRun: SdkStructuredRunFactory = (opts) => async () => {
    assert.equal(opts.tools.length, 1);
    assert.equal(opts.tools[0].name, "check_availability");
    await opts.tools[0].execute({
      size: "L",
      startDate: "2026-04-29",
      endDate: "2026-04-30",
    });
    return { reply: "L 码这两天有货，可以下单。" };
  };

  const runner = createCustomerServiceSdkRunner(fakeRun);
  const result = await runner(checkAvailabilityRuntime());

  assert.equal(result.reply, "L 码这两天有货，可以下单。");
  assert.equal(result.action.action, "check_availability");
  assert.equal(result.outputValidated, true);
  assert.equal(result.toolCalls[0].toolName, "check_availability");
  // productId 由 harness 从 event 注入，不信任模型自带。
  assert.equal(result.toolCalls[0].arguments.productId, "SUIT-001");
  assert.equal(result.toolResults.length, 1);
});

test("createCustomerServiceSdkRunner throws when a policy tool is not registered", async () => {
  const runtime = checkAvailabilityRuntime();
  runtime.registry = createDefaultToolRegistry();
  // 把 runPolicy 指向一个未注册工具名，装配阶段必须显式失败而非静默跳过。
  runtime.runPolicy = {
    ...runtime.runPolicy,
    toolNames: ["not_a_tool" as never],
  };
  const runner = createCustomerServiceSdkRunner(() => async () => ({
    reply: "x",
  }));
  await assert.rejects(runner(runtime), /not registered/);
});
