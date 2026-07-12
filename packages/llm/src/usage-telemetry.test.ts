// usage-telemetry 的单元测试：把 Agents SDK 的 Usage 归一成遥测记录（KV cache
// 观测的核心映射），以及 DeepSeek 费率的成本估算。无需真实 LLM——喂合成 usage 即可，
// 数据取自 step-0 探针实测（deepseek-v4-pro 第二次命中 cached_tokens=2048）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsSdkUsageToTelemetry,
  estimateCostCny,
} from "./usage-telemetry.js";

const MODEL = "deepseek-v4-pro";

test("agentsSdkUsageToTelemetry: 数组 inputTokensDetails 的 cached_tokens 计为命中，其余计为未命中", () => {
  // step-0 探针实测 call2：inputTokens=2049, cached=2048, output=35
  const record = agentsSdkUsageToTelemetry(MODEL, {
    inputTokens: 2049,
    outputTokens: 35,
    totalTokens: 2084,
    inputTokensDetails: [{ cached_tokens: 2048 }],
  });

  assert.equal(record.model, MODEL);
  assert.equal(record.operation, "agentsSdkRun");
  assert.equal(record.inputCacheHitTokens, 2048);
  assert.equal(record.inputCacheMissTokens, 1);
  assert.equal(record.outputTokens, 35);
  assert.equal(record.totalTokens, 2084);
  assert.equal(
    record.estimatedCostCny,
    estimateCostCny(MODEL, {
      inputCacheHitTokens: 2048,
      inputCacheMissTokens: 1,
      outputTokens: 35,
    }),
  );
});

test("agentsSdkUsageToTelemetry: 无缓存命中时全部输入计为未命中", () => {
  const record = agentsSdkUsageToTelemetry(MODEL, {
    inputTokens: 2049,
    outputTokens: 4,
    totalTokens: 2053,
    inputTokensDetails: [{ cached_tokens: 0 }],
  });

  assert.equal(record.inputCacheHitTokens, 0);
  assert.equal(record.inputCacheMissTokens, 2049);
});

test("agentsSdkUsageToTelemetry: 对象形态的 inputTokensDetails 同样读取 cached_tokens", () => {
  const record = agentsSdkUsageToTelemetry(MODEL, {
    inputTokens: 500,
    outputTokens: 10,
    inputTokensDetails: { cached_tokens: 100 },
  });

  assert.equal(record.inputCacheHitTokens, 100);
  assert.equal(record.inputCacheMissTokens, 400);
  // 缺 totalTokens 时回退为 input + output
  assert.equal(record.totalTokens, 510);
});

test("agentsSdkUsageToTelemetry: usage 缺失时归零，不抛错", () => {
  const record = agentsSdkUsageToTelemetry(MODEL, undefined);

  assert.deepEqual(
    {
      hit: record.inputCacheHitTokens,
      miss: record.inputCacheMissTokens,
      output: record.outputTokens,
      total: record.totalTokens,
      cost: record.estimatedCostCny,
    },
    { hit: 0, miss: 0, output: 0, total: 0, cost: 0 },
  );
});

test("agentsSdkUsageToTelemetry: 多段 inputTokensDetails 的 cached_tokens 累加", () => {
  const record = agentsSdkUsageToTelemetry(MODEL, {
    inputTokens: 300,
    outputTokens: 5,
    inputTokensDetails: [{ cached_tokens: 100 }, { cached_tokens: 50 }],
  });

  assert.equal(record.inputCacheHitTokens, 150);
  assert.equal(record.inputCacheMissTokens, 150);
});

test("estimateCostCny: cache 命中比未命中便宜（pro 费率）", () => {
  const hitCost = estimateCostCny(MODEL, {
    inputCacheHitTokens: 1000,
    inputCacheMissTokens: 0,
    outputTokens: 0,
  });
  const missCost = estimateCostCny(MODEL, {
    inputCacheHitTokens: 0,
    inputCacheMissTokens: 1000,
    outputTokens: 0,
  });

  assert.ok(hitCost < missCost, "cache 命中成本应低于未命中");
  assert.equal(hitCost, Number((1000 * 0.000000025).toFixed(12)));
  assert.equal(missCost, Number((1000 * 0.000003).toFixed(12)));
});
