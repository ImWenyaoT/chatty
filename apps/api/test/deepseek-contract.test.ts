import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { format } from "node:util";
import {
  Agent,
  ModelBehaviorError,
  OpenAIProvider,
  RunContext,
  Runner,
  tool,
} from "@openai/agents";
import { z } from "zod";
import {
  ChattyRunModule,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
} from "../src/agent-runtime.js";
import { createHttpApplication } from "../src/http-application.js";
import { NativeRuntime } from "../src/runtime.js";

const liveTest = process.env.CHATTY_RUN_DEEPSEEK === "1" ? test : test.skip;

async function withSecretGuard<T>(
  directory: string,
  run: () => Promise<T>,
): Promise<T> {
  const output: string[] = [];
  const methods = ["debug", "error", "info", "log", "warn"] as const;
  const originals = Object.fromEntries(
    methods.map((method) => [method, console[method]]),
  ) as Record<(typeof methods)[number], typeof console.log>;
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      output.push(format(...args));
    };
  }
  let result: T | undefined;
  let failure: unknown;
  try {
    result = await run();
  } catch (error) {
    failure = error;
  } finally {
    for (const method of methods) console[method] = originals[method];
  }
  assertSecretAbsent(
    directory,
    output.join("\n") +
      (failure === undefined ? JSON.stringify(result) : String(failure)),
  );
  if (failure !== undefined) throw failure;
  return result as T;
}

async function withLiveRuntime<T>(
  run: (module: ChattyRunModule, runtime: NativeRuntime) => Promise<T>,
): Promise<T> {
  assert(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required");
  const directory = mkdtempSync(join(tmpdir(), "chatty-deepseek-contract-"));
  const databasePath = join(directory, "contract.sqlite");
  const runtime = new NativeRuntime(databasePath);
  const module = new ChattyRunModule(runtime);
  return withSecretGuard(directory, async () => {
    try {
      return await run(module, runtime);
    } finally {
      await module.close();
      runtime.close();
    }
  }).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function assertSecretAbsent(directory: string, serialized: string): void {
  const secret = process.env.OPENAI_API_KEY as string;
  const secretBytes = Buffer.from(secret);
  const exposedInFile = readdirSync(directory, {
    recursive: true,
    encoding: "utf8",
  }).some((entry) => {
    const path = join(directory, entry);
    return statSync(path).isFile() && readFileSync(path).includes(secretBytes);
  });
  if (serialized.includes(secret) || exposedInFile) {
    throw new Error("OPENAI_API_KEY was exposed by the contract run");
  }
}

liveTest("real DeepSeek completes a no-tool TypeScript run", async () => {
  await withLiveRuntime(async (module) => {
    const app = createHttpApplication({
      nativeRunFactory: () => ({
        run: module.run.bind(module),
        sessionMessages: module.sessionMessages.bind(module),
        close: async () => undefined,
      }),
      customerIdentity: () => "contract-customer",
      requestIdentity: () => "contract-no-tool",
    });
    try {
      const response = await app.handle(
        new Request("http://chatty.local/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "请只回复 OK，不要调用 Tool" }),
        }),
      );
      assert.equal(response.status, 200);
      const result = (await response.json()) as {
        customer_id: string;
        status: string;
        reply: string;
        knowledge_search_results: unknown[];
        memory_events: unknown[];
      };
      assert.equal(result.customer_id, "contract-customer");
      assert.equal(result.status, "responded");
      assert(result.reply);
      assert.deepEqual(result.knowledge_search_results, []);
      assert.deepEqual(result.memory_events, []);
      return result;
    } finally {
      await app.close();
    }
  });
});

liveTest(
  "real DeepSeek uses Knowledge with source and local Trace",
  async () => {
    await withLiveRuntime(async (module, runtime) => {
      const result = await module.run({
        message: "租期从哪一天开始？请查询店铺知识并标注来源。",
        customer_id: "contract-customer",
        request_id: "contract-knowledge",
      });
      assert(result.knowledge_search_results.length > 0);
      assert(
        result.knowledge_search_results.some((item) =>
          result.reply.includes(item.source),
        ),
      );
      const trace = runtime.traces.get(result.trace_id);
      assert.equal(trace?.status, "completed");
      assert(runtime.traces.spanTypes(result.trace_id).includes("function"));
      assert((trace?.knowledge_sources.length ?? 0) > 0);
      return { result, trace };
    });
  },
);

liveTest(
  "real DeepSeek uses consecutive Tools for one verified order",
  async () => {
    await withLiveRuntime(async (module, runtime) => {
      const result = await module.run({
        message:
          "请先检查 SUIT-001 的 L 码在 2026-08-01 至 2026-08-03 是否可租；若可租，立即创建 1 件、760 元、送到上海市静安区、风险信息为无的订单。这个任务不需要知识搜索，只使用库存和订单 Tool。",
        customer_id: "contract-customer",
        request_id: "contract-order",
      });
      assert.equal(result.business_outcome, "verified");
      assert.equal(runtime.commerce.listOrders().length, 1);
      assert(
        runtime.traces
          .spans(result.trace_id)
          .filter((span) => span.span_type === "function").length >= 2,
      );
      return result;
    });
  },
);

liveTest("real DeepSeek SQLite Session supplies previous context", async () => {
  await withLiveRuntime(async (module) => {
    const first = await module.run({
      message: "我叫小林，请确认收到。",
      customer_id: "contract-customer",
      request_id: "contract-session-1",
    });
    const second = await module.run({
      message: "我刚才说我叫什么？",
      session_id: first.session_id,
      customer_id: "contract-customer",
      request_id: "contract-session-2",
    });
    assert.equal(second.session_id, first.session_id);
    assert.match(second.reply, /小林/);
    return { first, second };
  });
});

liveTest("missing order parameters cannot create an order", async () => {
  await withLiveRuntime(async (module, runtime) => {
    const result = await module.run({
      message: "立即帮我创建一件 SUIT-001 的租赁订单，但我不提供尺码和日期。",
      customer_id: "contract-customer",
      request_id: "contract-missing-parameters",
    });
    assert.deepEqual(runtime.commerce.listOrders(), []);
    assert.notEqual(result.business_outcome, "verified");
    return result;
  });
});

liveTest("real DeepSeek produces valid strict Tool arguments", async () => {
  const calls: string[] = [];
  const recordSize = tool({
    name: "record_size",
    description: "Record the explicit size L.",
    parameters: z.object({ size: z.literal("L") }).strict(),
    errorFunction: null,
    execute: ({ size }) => {
      calls.push(size);
      return "recorded";
    },
  });
  const provider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    useResponses: false,
  });
  const directory = mkdtempSync(join(tmpdir(), "chatty-deepseek-tool-"));
  try {
    await withSecretGuard(directory, async () => {
      const runner = new Runner({
        modelProvider: provider,
        tracingDisabled: true,
      });
      const agent = new Agent({
        name: "Tool parameter contract",
        instructions:
          "必须调用 record_size，使用客户明确提供的尺码；Tool 成功后简短回答。",
        model: process.env.MODEL_ID ?? DEFAULT_MODEL_ID,
        modelSettings: { providerData: { thinking: { type: "disabled" } } },
        tools: [recordSize],
      });
      const result = await runner.run(agent, "尺码是 L，请记录。");
      assert.deepEqual(calls, ["L"]);
      return result.finalOutput;
    });
  } finally {
    await provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TypeScript SDK rejects invalid strict Tool arguments locally", async () => {
  const calls: string[] = [];
  const recordSize = tool({
    name: "record_size",
    description: "Record the explicit size L.",
    parameters: z.object({ size: z.literal("L") }).strict(),
    errorFunction: null,
    execute: ({ size }) => {
      calls.push(size);
      return "recorded";
    },
  });
  await assert.rejects(
    recordSize.invoke(
      new RunContext({} as never),
      JSON.stringify({ size: "XXL" }),
    ),
    ModelBehaviorError,
  );
  assert.deepEqual(calls, []);
});
