import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  createAgentsSdkStructuredRunner,
  createAgentsSdkToolLoopFn,
  createDeepSeekAgentsModelFromEnv,
} from "./agents-sdk-adapter.js";
import { readLlmEnv } from "./client-from-env.js";

const contractSkip =
  process.env.CHATTY_RUN_DEEPSEEK_CONTRACTS !== "1"
    ? "set CHATTY_RUN_DEEPSEEK_CONTRACTS=1 to opt in"
    : !process.env.OPENAI_API_KEY
      ? "OPENAI_API_KEY is required for explicit DeepSeek contracts"
      : false;

const memorySchema = z
  .object({
    facts: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
  })
  .strict();
const compactionSchema = z
  .object({ currentGoal: z.string(), unresolved: z.array(z.string()) })
  .strict();

test(
  "DeepSeek beta returns structured memory and compaction outputs",
  { skip: contractSkip },
  async () => {
    const endpoint = new URL(readLlmEnv().baseURL ?? "");
    assert.equal(endpoint.hostname, "api.deepseek.com");
    assert.equal(endpoint.pathname.replace(/\/$/, ""), "/beta");
    const model = createDeepSeekAgentsModelFromEnv();
    const modelName = readLlmEnv().chatModel;
    const runMemory = createAgentsSdkStructuredRunner({
      instructions: "Extract only the stable customer sizing fact.",
      input: "Customer says: my stable suit size is L.",
      model,
      modelName,
      outputType: memorySchema,
      outputExample: '{"facts":[{"key":"suit_size","value":"L"}]}',
      toolChoice: "none",
      maxTurns: 1,
      signal: AbortSignal.timeout(30_000),
    });
    const runCompaction = createAgentsSdkStructuredRunner({
      instructions: "Compact the conversation goal and unresolved work.",
      input:
        "Goal: rent a suit. Confirmed size L. Still need the delivery date.",
      model,
      modelName,
      outputType: compactionSchema,
      outputExample:
        '{"currentGoal":"rent a suit","unresolved":["delivery date"]}',
      toolChoice: "none",
      maxTurns: 1,
      signal: AbortSignal.timeout(30_000),
    });

    assert.equal(
      (await runMemory()).facts.some((fact) => fact.value === "L"),
      true,
    );
    assert.equal((await runCompaction()).unresolved.length > 0, true);
  },
);

test(
  "DeepSeek beta accepts long context and reports normalized usage",
  { skip: contractSkip },
  async () => {
    const telemetry: Array<{
      inputCacheHitTokens: number;
      inputCacheMissTokens: number;
      outputTokens: number;
      totalTokens: number;
    }> = [];
    const runLongContext = createAgentsSdkToolLoopFn({
      instructions:
        "Answer with only the final marker from the supplied context.",
      model: createDeepSeekAgentsModelFromEnv(),
      modelName: readLlmEnv().chatModel,
      toolChoice: "none",
      maxTurns: 1,
      signal: AbortSignal.timeout(30_000),
      telemetry: (record) => telemetry.push(record),
    });
    const output = await runLongContext(
      `${"bounded context line\n".repeat(4_000)}FINAL_MARKER_726`,
    );

    assert.match(output, /FINAL_MARKER_726/);
    assert.equal(telemetry.length > 0, true);
    assert.equal(
      telemetry[0].inputCacheHitTokens + telemetry[0].inputCacheMissTokens > 0,
      true,
    );
    assert.equal(telemetry[0].totalTokens >= telemetry[0].outputTokens, true);
  },
);

test(
  "DeepSeek beta honors AbortSignal cancellation",
  { skip: contractSkip },
  async () => {
    const controller = new AbortController();
    const runCancelled = createAgentsSdkToolLoopFn({
      instructions: "Write a long explanation.",
      input: "Explain rental operations.",
      model: createDeepSeekAgentsModelFromEnv(),
      modelName: readLlmEnv().chatModel,
      toolChoice: "none",
      maxTurns: 1,
      signal: controller.signal,
    });

    const pending = runCancelled(
      "Explain every operational detail. ".repeat(8_000),
    );
    setTimeout(
      () => controller.abort(new Error("contract cancellation")),
      25,
    ).unref();
    const watchdog = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("DeepSeek cancellation contract timed out")),
        30_000,
      ).unref();
    });
    await assert.rejects(Promise.race([pending, watchdog]));
    assert.equal(controller.signal.aborted, true);
  },
);
