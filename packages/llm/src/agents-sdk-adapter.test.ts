import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentsSdkToolLoopFn,
  createDeepSeekAgentsModelFromEnv,
  createDeepSeekCompatibleFetch,
  toAgentsSdkFunctionTool,
} from "./agents-sdk-adapter.js";

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
  assert.equal(sdkTool.strict, true);
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
  await compatibleFetch("https://api.deepseek.com/beta/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      response_format: { type: "json_schema", json_schema: { name: "output" } },
    }),
  });
  assert.deepEqual(JSON.parse(capturedBody).response_format, {
    type: "json_object",
  });
});
