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

function answerQuestionRuntime(): Parameters<CustomerServiceSdkRunner>[0] {
  const task: CustomerServiceTask = {
    kind: "answer_question",
    goal: "回答尺码问题",
    terminality: "reply_and_wait",
    requiredContext: [],
    risk: "low",
  };
  const knowledge = {
    search: (query: string) => [
      { section: `${query} 参考`, text: "身高 175-181、体重 66-80 建议 L" },
    ],
  };
  return {
    ...checkAvailabilityRuntime(),
    task,
    runPolicy: createCustomerServiceRunPolicy(task),
    context: {
      fragments: [
        { kind: "task", label: "当前客服任务", content: "answer_question" },
        {
          kind: "user_message",
          label: "用户本轮消息",
          content: "我 178cm 72kg，这套建议什么码？",
        },
      ],
      prompt: "",
    },
    registry: createDefaultToolRegistry(knowledge),
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

test("createCustomerServiceSdkRunner routes knowledge search through the shared execution seam", async () => {
  const runtime = answerQuestionRuntime();
  const events: Array<{ type: string; payload: unknown }> = [];
  runtime.emitEvent = (type, payload) => events.push({ type, payload });
  const fakeRun: SdkStructuredRunFactory = (opts) => async () => {
    const search = opts.tools.find((tool) => tool.name === "search_knowledge");
    assert.ok(search);
    const first = await search.execute({ query: "尺码推荐" });
    const duplicate = await search.execute({ query: "尺码表" });
    assert.match(JSON.stringify(first), /建议 L/);
    assert.equal(duplicate, "已搜索过 SUIT-001 尺码。请基于已有结果直接回答。");
    return { reply: "建议选 L 码。" };
  };

  const result = await createCustomerServiceSdkRunner(fakeRun)(runtime);

  assert.deepEqual(
    result.toolCalls.map((call) => call.arguments),
    [{ query: "SUIT-001 尺码" }],
  );
  assert.equal(result.toolResults.length, 1);
  const knowledge = runtime.context.fragments.filter(
    (fragment) => fragment.kind === "knowledge",
  );
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].label, "知识库检索：SUIT-001 尺码");
  assert.match(knowledge[0].content, /建议 L/);
  assert.deepEqual(
    events.map((event) => event.type),
    ["model_called", "tool_attempted", "tool_completed"],
  );
});

test("createCustomerServiceSdkRunner grounds a price reply in the SQLite search evidence", async () => {
  const runtime = answerQuestionRuntime();
  runtime.event = {
    ...runtime.event,
    payload: { question: "这款多少钱一天？" },
  };
  runtime.context = {
    ...runtime.context,
    fragments: [
      { kind: "task", label: "当前客服任务", content: "answer_question" },
      {
        kind: "user_message",
        label: "用户本轮消息",
        content: "这款多少钱一天？",
      },
    ],
  };
  runtime.runPolicy = createCustomerServiceRunPolicy(runtime.task, {
    requireKnowledgeSearch: true,
  });
  runtime.registry = createDefaultToolRegistry({
    search: () => [
      {
        section: "黑色双排扣西装 › 租赁价格",
        text: "第一天租赁价格 199 元；续租每天 99.5 元。",
      },
    ],
  });
  const fakeRun: SdkStructuredRunFactory = (opts) => async () => {
    assert.equal(opts.toolChoice, "search_knowledge");
    const search = opts.tools.find((tool) => tool.name === "search_knowledge");
    assert.ok(search);
    const evidence = await search.execute({ query: "价格" });
    assert.match(JSON.stringify(evidence), /199 元/);
    return { reply: "这款第一天 199 元，续租每天 99.5 元。" };
  };

  const result = await createCustomerServiceSdkRunner(fakeRun)(runtime);

  assert.equal(result.reply, "这款第一天 199 元，续租每天 99.5 元。");
  assert.deepEqual(
    result.toolCalls.map((call) => call.arguments),
    [{ query: "价格" }],
  );
  assert.match(JSON.stringify(result.toolResults), /199 元/);
  assert.match(
    runtime.context.fragments.find((fragment) => fragment.kind === "knowledge")
      ?.content ?? "",
    /199 元/,
  );
});

test("createCustomerServiceSdkRunner audits a knowledge search before cancellation", async () => {
  const runtime = answerQuestionRuntime();
  runtime.signal = AbortSignal.abort(new Error("search cancelled"));
  const events: Array<{ type: string; payload: unknown }> = [];
  runtime.emitEvent = (type, payload) => events.push({ type, payload });
  const fakeRun: SdkStructuredRunFactory = (opts) => async () => {
    const search = opts.tools.find((tool) => tool.name === "search_knowledge");
    assert.ok(search);
    await search.execute({ query: "尺码推荐" });
    return { reply: "unreachable" };
  };

  await assert.rejects(
    createCustomerServiceSdkRunner(fakeRun)(runtime),
    /search cancelled/,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["model_called", "tool_attempted"],
  );
  assert.deepEqual((events[1].payload as { arguments: unknown }).arguments, {
    query: "SUIT-001 尺码",
  });
});

test("createCustomerServiceSdkRunner records a denied knowledge search as a tool result", async () => {
  const runtime = answerQuestionRuntime();
  runtime.sessionStatus = "closed";
  const fakeRun: SdkStructuredRunFactory = (opts) => async () => {
    const search = opts.tools.find((tool) => tool.name === "search_knowledge");
    assert.ok(search);
    const denied = await search.execute({ query: "押金" });
    assert.deepEqual(denied, {
      error: "PolicyDenyError",
      message: "policy denied tool search_knowledge: session closed",
    });
    return { reply: "当前会话已关闭，无法继续查询。" };
  };

  const result = await createCustomerServiceSdkRunner(fakeRun)(runtime);

  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolResults, [
    {
      error: "PolicyDenyError",
      message: "policy denied tool search_knowledge: session closed",
    },
  ]);
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
