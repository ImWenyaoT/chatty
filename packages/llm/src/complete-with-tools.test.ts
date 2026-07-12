// completeWithTools 的 mock client 测试（docs/archive/agentic-search-design.md B2 验收）：
// 覆盖 tool_calls 回复与纯文本回复两种形态的解析，以及消息/工具定义到
// Chat Completions 线格式的映射（tool_calls / role:'tool' / tools 参数省略）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  createChatCompletionsAdapter,
  type ToolDefinition,
} from "./chat-completions-adapter.js";

/** 构造只回放固定响应的 mock client，并捕获发出的请求参数供断言。 */
function mockClient(
  message: unknown,
  capture?: { params?: unknown },
  usage?: Record<string, number>,
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: unknown) => {
          if (capture) capture.params = params;
          return { choices: [{ message }], usage };
        },
      },
    },
  } as unknown as OpenAI;
}

const SEARCH_TOOL: ToolDefinition = {
  name: "search_knowledge",
  description: "搜索店铺知识库",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

test("模型回复 tool_calls 时解析为 toolCalls 形态（arguments 保持原始字符串）", async () => {
  const adapter = createChatCompletionsAdapter({
    client: mockClient({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "search_knowledge", arguments: '{"query":"押金"}' },
        },
      ],
    }),
    model: "test-model",
  });
  const result = await adapter.completeWithTools(
    [{ role: "user", content: "押金多少" }],
    [SEARCH_TOOL],
  );
  assert.deepEqual(result, {
    toolCalls: [
      { id: "call_1", name: "search_knowledge", arguments: '{"query":"押金"}' },
    ],
  });
});

test("模型回复纯文本时解析为 text 形态并去除首尾空白", async () => {
  const adapter = createChatCompletionsAdapter({
    client: mockClient({ role: "assistant", content: '  {"reply":"您好"}\n' }),
    model: "test-model",
  });
  const result = await adapter.completeWithTools(
    [{ role: "user", content: "在吗" }],
    [SEARCH_TOOL],
  );
  assert.deepEqual(result, { text: '{"reply":"您好"}' });
});

test("消息与工具定义映射为线格式：tools 数组、assistant.tool_calls、role:tool 回填", async () => {
  const capture: { params?: unknown } = {};
  const adapter = createChatCompletionsAdapter({
    client: mockClient({ role: "assistant", content: "好的" }, capture),
    model: "test-model",
  });
  await adapter.completeWithTools(
    [
      { role: "user", content: "押金多少" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "search_knowledge",
            arguments: '{"query":"押金"}',
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "找到 1 条相关内容：…" },
    ],
    [SEARCH_TOOL],
  );
  const params = capture.params as {
    tools: Array<{
      type: string;
      function: { name: string; parameters: unknown };
    }>;
    messages: Array<Record<string, unknown>>;
  };
  assert.equal(params.tools.length, 1);
  assert.equal(params.tools[0].type, "function");
  assert.equal(params.tools[0].function.name, "search_knowledge");
  assert.deepEqual(params.messages[1].tool_calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "search_knowledge", arguments: '{"query":"押金"}' },
    },
  ]);
  assert.deepEqual(params.messages[2], {
    role: "tool",
    tool_call_id: "call_1",
    content: "找到 1 条相关内容：…",
  });
});

test("tools 为空数组时不带 tools 参数（有界循环收尾轮的形态）", async () => {
  const capture: { params?: unknown } = {};
  const adapter = createChatCompletionsAdapter({
    client: mockClient({ role: "assistant", content: "直接作答" }, capture),
    model: "test-model",
  });
  const result = await adapter.completeWithTools(
    [{ role: "user", content: "收尾" }],
    [],
  );
  assert.deepEqual(result, { text: "直接作答" });
  assert.ok(!("tools" in (capture.params as Record<string, unknown>)));
});

test("adapter captures pro usage telemetry and applies output token cap", async () => {
  const records: unknown[] = [];
  const capture: { params?: unknown } = {};
  const adapter = createChatCompletionsAdapter({
    client: mockClient(
      { role: "assistant", content: '  {"reply":"您好"}\n' },
      capture,
      {
        prompt_cache_hit_tokens: 1200,
        prompt_cache_miss_tokens: 300,
        completion_tokens: 80,
        total_tokens: 1580,
      },
    ),
    model: "deepseek-v4-pro",
    maxOutputTokens: 256,
    telemetry: (record) => records.push(record),
  });

  await adapter.completeJson([{ role: "user", content: "在吗" }]);

  assert.equal((capture.params as { max_tokens?: number }).max_tokens, 256);
  assert.deepEqual(records, [
    {
      model: "deepseek-v4-pro",
      operation: "completeJson",
      inputCacheHitTokens: 1200,
      inputCacheMissTokens: 300,
      outputTokens: 80,
      totalTokens: 1580,
      estimatedCostCny: 0.00141,
    },
  ]);
});
