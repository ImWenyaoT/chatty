import { test } from "node:test";
import assert from "node:assert/strict";
import { Usage, type Model, type ModelRequest } from "@openai/agents";
import {
  createAgentsSdkCustomerServiceTextRunner,
  createAgentsSdkToolLoopFn,
  createDeepSeekAgentsModelFromEnv,
  createDeepSeekCompatibleFetch,
  toAgentsSdkFunctionTool,
} from "./agents-sdk-adapter.js";

function toolThenReplyModel(toolCallCount = 1): {
  model: Model;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const model = {
    async getResponse(request: ModelRequest) {
      requests.push(request);
      const hasToolResult = /押金以订单页面为准|检索结果-/.test(
        JSON.stringify(request.input),
      );
      if (hasToolResult) {
        return {
          usage: new Usage(),
          output: [
            {
              type: "message" as const,
              role: "assistant" as const,
              status: "completed" as const,
              content: [
                {
                  type: "output_text" as const,
                  text: "押金以订单页面为准。",
                },
              ],
            },
          ],
        };
      }
      return {
        usage: new Usage(),
        output: Array.from({ length: toolCallCount }, (_, index) => ({
          type: "function_call" as const,
          callId: `call-${requests.length}-${index}`,
          name: "search_knowledge",
          arguments: '{"query":"押金"}',
        })),
      };
    },
    async *getStreamedResponse() {},
  } satisfies Model;
  return { model, requests };
}

test("customer-service runner uses the SDK loop to return tool results to the model", async () => {
  const { model, requests } = toolThenReplyModel();
  let searches = 0;
  let telemetryCalls = 0;
  const runCustomerService = createAgentsSdkCustomerServiceTextRunner({
    instructions: "先检索事实，再直接回答用户。",
    input: "押金多少？",
    model,
    tools: [
      {
        name: "search_knowledge",
        description: "检索知识",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        execute: () => {
          searches += 1;
          return "押金以订单页面为准";
        },
      },
    ],
    toolChoice: "auto",
    maxTurns: 4,
    telemetry: () => {
      telemetryCalls += 1;
    },
  });

  const result = await runCustomerService();

  assert.deepEqual(result, { reply: "押金以订单页面为准。" });
  assert.equal(searches, 1);
  assert.equal(requests.length, 2);
  assert.equal(telemetryCalls, 2);
  assert.equal(requests[1].tools.length, 1);
  // SDK resets a forced/explicit choice after a tool call; undefined is auto semantics.
  assert.equal(requests[1].modelSettings.toolChoice, undefined);
  assert.match(JSON.stringify(requests[1].input), /押金以订单页面为准/);
});

test("customer-service runner preserves every result when a provider emits multiple tool calls", async () => {
  const { model, requests } = toolThenReplyModel(2);
  let searches = 0;
  const runCustomerService = createAgentsSdkCustomerServiceTextRunner({
    instructions: "先检索事实，再直接回答用户。",
    input: "押金多少？",
    model,
    tools: [
      {
        name: "search_knowledge",
        description: "检索知识",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        execute: () => `检索结果-${++searches}`,
      },
    ],
    toolChoice: "auto",
    maxTurns: 4,
  });

  await runCustomerService();

  assert.equal(searches, 2);
  const finalInput = JSON.stringify(requests[1].input);
  assert.match(finalInput, /检索结果-1/);
  assert.match(finalInput, /检索结果-2/);
});

test("createAgentsSdkToolLoopFn exposes an SDK-backed tool loop adapter boundary", () => {
  assert.equal(typeof createAgentsSdkToolLoopFn, "function");
});

test("toAgentsSdkFunctionTool converts a Chatty tool into an SDK function tool", async () => {
  const sdkTool = toAgentsSdkFunctionTool({
    name: "search_knowledge",
    description: "Search seller knowledge",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    needsApproval: false,
    execute: async (input) => ({ ok: true, input }),
  });

  assert.equal(sdkTool.type, "function");
  assert.equal(sdkTool.name, "search_knowledge");
  assert.equal(sdkTool.description, "Search seller knowledge");
  assert.deepEqual(sdkTool.parameters, {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  });
  // 标准端点非 strict function calling（strict 仅 DeepSeek beta 提供）。
  assert.equal(sdkTool.strict, false);
  assert.equal(
    await sdkTool.needsApproval({} as never, '{"query":"押金"}', undefined),
    false,
  );
  assert.equal(
    await sdkTool.invoke({} as never, '{"query":"押金"}'),
    '{"ok":true,"input":{"query":"押金"}}',
  );
});

test("toAgentsSdkFunctionTool preserves approval metadata for sensitive tools", async () => {
  const sdkTool = toAgentsSdkFunctionTool({
    name: "transfer_to_human",
    description: "Transfer a risky customer-service turn to a human",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
    needsApproval: true,
    execute: async (input) => ({ queued: true, input }),
  });

  assert.equal(
    await sdkTool.needsApproval(
      {} as never,
      '{"reason":"退款争议"}',
      undefined,
    ),
    true,
  );
  assert.equal(
    await sdkTool.invoke({} as never, '{"reason":"退款争议"}'),
    '{"queued":true,"input":{"reason":"退款争议"}}',
  );
});

test("createDeepSeekAgentsModelFromEnv wraps DeepSeek with SDK Chat Completions model", () => {
  const model = createDeepSeekAgentsModelFromEnv({
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://api.deepseek.com",
    CHAT_MODEL: "deepseek-v4-pro",
  });

  assert.equal(model.constructor.name, "OpenAIChatCompletionsModel");
});

test("DeepSeek transport maps SDK json_schema output to supported json_object", async () => {
  let capturedBody = "";
  const compatibleFetch = createDeepSeekCompatibleFetch(
    async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    },
  );
  await compatibleFetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      response_format: { type: "json_schema", json_schema: { name: "output" } },
    }),
  });
  assert.deepEqual(JSON.parse(capturedBody).response_format, {
    type: "json_object",
  });
});

test("DeepSeek transport rewrites json_schema even when the URL is a URL object", async () => {
  let capturedBody = "";
  const compatibleFetch = createDeepSeekCompatibleFetch(
    async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    },
  );
  await compatibleFetch(new URL("https://api.deepseek.com/chat/completions"), {
    method: "POST",
    body: JSON.stringify({
      response_format: { type: "json_schema", json_schema: { name: "o" } },
    }),
  });
  assert.equal(JSON.parse(capturedBody).response_format.type, "json_object");
});

test("DeepSeek transport passes non chat-completions requests through untouched", async () => {
  let sawUrl = "";
  let capturedBody = "";
  const compatibleFetch = createDeepSeekCompatibleFetch(async (input, init) => {
    sawUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return new Response("{}", { status: 200 });
  });
  const body = JSON.stringify({
    response_format: { type: "json_schema", json_schema: { name: "o" } },
  });
  await compatibleFetch("https://api.deepseek.com/models", {
    method: "POST",
    body,
  });
  // 非 /chat/completions 端点不改写：json_schema 原样透传。
  assert.equal(sawUrl, "https://api.deepseek.com/models");
  assert.equal(JSON.parse(capturedBody).response_format.type, "json_schema");
});

test("DeepSeek transport leaves non-json_schema response_format unchanged", async () => {
  let capturedBody = "";
  const compatibleFetch = createDeepSeekCompatibleFetch(
    async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    },
  );
  await compatibleFetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ response_format: { type: "json_object" } }),
  });
  assert.equal(JSON.parse(capturedBody).response_format.type, "json_object");
});

test("DeepSeek transport passes through a body that is not valid JSON", async () => {
  let capturedBody = "";
  const compatibleFetch = createDeepSeekCompatibleFetch(
    async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    },
  );
  await compatibleFetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    body: "not-json",
  });
  // 坏 body 不抛错，原样透传交给底层 fetch。
  assert.equal(capturedBody, "not-json");
});

test("DeepSeek transport passes through requests without a string body", async () => {
  let called = false;
  const compatibleFetch = createDeepSeekCompatibleFetch(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  await compatibleFetch("https://api.deepseek.com/chat/completions", {
    method: "GET",
  });
  assert.equal(called, true);
});
