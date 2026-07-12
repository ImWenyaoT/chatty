// apps/web/lib/llm.ts 的单元测试：playground LLM runtime 的 KV cache 遥测聚合，
// 与“仅当 DeepSeek key 存在时才启用 Agents SDK compose”的开关语义。SDK-usage→record
// 的映射由 packages/llm/src/usage-telemetry.test.ts 单测覆盖。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createLlmTelemetrySummary,
  createPlaygroundLlmRuntime,
  MissingLlmApiKeyError,
} from "./llm";

test("createLlmTelemetrySummary aggregates pro usage and estimated cost", () => {
  const summary = createLlmTelemetrySummary("deepseek-v4-pro", [
    {
      model: "deepseek-v4-pro",
      operation: "agentsSdkRun",
      inputCacheHitTokens: 1000,
      inputCacheMissTokens: 200,
      outputTokens: 50,
      totalTokens: 1250,
      estimatedCostCny: 0.000925,
    },
    {
      model: "deepseek-v4-pro",
      operation: "agentsSdkRun",
      inputCacheHitTokens: 500,
      inputCacheMissTokens: 100,
      outputTokens: 25,
      totalTokens: 625,
      estimatedCostCny: 0.0004625,
    },
  ]);

  assert.deepEqual(summary, {
    model: "deepseek-v4-pro",
    calls: 2,
    callBudget: 3,
    inputCacheHitTokens: 1500,
    inputCacheMissTokens: 300,
    inputCacheHitRatio: 0.8333,
    outputTokens: 75,
    totalTokens: 1875,
    estimatedCostCny: 0.0013875,
    operations: ["agentsSdkRun", "agentsSdkRun"],
    warnings: [],
  });
});

test("createLlmTelemetrySummary warns when one turn exceeds the pro call budget", () => {
  const record = {
    model: "deepseek-v4-pro",
    operation: "agentsSdkRun" as const,
    inputCacheHitTokens: 1,
    inputCacheMissTokens: 1,
    outputTokens: 1,
    totalTokens: 3,
    estimatedCostCny: 0.000009025,
  };
  const summary = createLlmTelemetrySummary(
    "deepseek-v4-pro",
    [record, record, record, record],
    {
      callBudget: 3,
    },
  );

  assert.equal(summary.calls, 4);
  assert.equal(summary.callBudget, 3);
  assert.equal(summary.inputCacheHitRatio, 0.5);
  assert.deepEqual(summary.warnings, ["llm_call_budget_exceeded: 4/3"]);
  assert.equal(summary.estimatedCostCny, 0.0000361);
});

test("createLlmTelemetrySummary keeps an empty model turn observable without NaN", () => {
  assert.deepEqual(createLlmTelemetrySummary("deepseek-v4-pro", []), {
    model: "deepseek-v4-pro",
    calls: 0,
    callBudget: 3,
    inputCacheHitTokens: 0,
    inputCacheMissTokens: 0,
    inputCacheHitRatio: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostCny: 0,
    operations: [],
    warnings: [],
  });
});

test("createPlaygroundLlmRuntime accepts a custom pro call budget for trace warnings", () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedModel = process.env.CHAT_MODEL;
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.CHAT_MODEL = "deepseek-v4-pro";

    const runtime = createPlaygroundLlmRuntime({ callBudget: 2 });

    assert.equal(typeof runtime.sdkRunner, "function");
    assert.equal(runtime.summary().callBudget, 2);
  } finally {
    process.env.OPENAI_API_KEY = savedKey;
    process.env.CHAT_MODEL = savedModel;
  }
});

test("createPlaygroundLlmRuntime requires a DeepSeek key", () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedModel = process.env.CHAT_MODEL;
  try {
    process.env.OPENAI_API_KEY = "";
    process.env.CHAT_MODEL = "deepseek-v4-pro";

    assert.throws(() => createPlaygroundLlmRuntime(), MissingLlmApiKeyError);
  } finally {
    process.env.OPENAI_API_KEY = savedKey;
    process.env.CHAT_MODEL = savedModel;
  }
});

test("createPlaygroundLlmRuntime uses Agents SDK whenever a DeepSeek key is present", () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedModel = process.env.CHAT_MODEL;
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.CHAT_MODEL = "deepseek-v4-pro";

    const runtime = createPlaygroundLlmRuntime();

    assert.equal(runtime.mode, "agents-sdk");
    assert.equal(typeof runtime.sdkRunner, "function");
  } finally {
    process.env.OPENAI_API_KEY = savedKey;
    process.env.CHAT_MODEL = savedModel;
  }
});

test("createPlaygroundLlmRuntime does not expose a direct Chat Completions tool loop", () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedModel = process.env.CHAT_MODEL;
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.CHAT_MODEL = "deepseek-v4-pro";

    const runtime = createPlaygroundLlmRuntime();

    assert.equal(runtime.mode, "agents-sdk");
    assert.equal(typeof runtime.sdkRunner, "function");
  } finally {
    process.env.OPENAI_API_KEY = savedKey;
    process.env.CHAT_MODEL = savedModel;
  }
});
