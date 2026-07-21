import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import { ChattyRunModule } from "../src/agent-runtime.js";
import { NativeRuntime } from "../src/runtime.js";

type ScriptItem =
  | { type: "message"; id: string; text: string }
  | { type: "tool"; callId: string; name: string; arguments: unknown };

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly script: ScriptItem[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const item = this.script[this.index++];
    if (item === undefined) throw new Error("script exhausted");
    let output: AgentOutputItem;
    if (item.type === "tool") {
      output = {
        type: "function_call",
        callId: item.callId,
        name: item.name,
        arguments: JSON.stringify(item.arguments),
        status: "completed",
      };
    } else {
      output = {
        type: "message",
        id: item.id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: item.text }],
      };
    }
    return { usage: new Usage(), output: [output] };
  }

  getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw new Error("streaming is not used by deterministic tests");
  }
}

const knowledgePath = resolve(
  import.meta.dirname,
  "../../../knowledge/records.jsonl",
);

async function withRunModule(
  model: Model,
  run: (module: ChattyRunModule, runtime: NativeRuntime) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "chatty-agent-runtime-"));
  const runtime = new NativeRuntime(join(directory, "chatty.sqlite"));
  const module = new ChattyRunModule(runtime, {
    model,
    modelId: "typescript-scripted-model",
    knowledgePath,
  });
  try {
    await run(module, runtime);
  } finally {
    await module.close();
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("official TypeScript Runner persists Session history and local Trace", async () => {
  const model = new ScriptedModel([
    { type: "message", id: "message-1", text: "你好，小林。" },
    { type: "message", id: "message-2", text: "你刚才说你叫小林。" },
  ]);
  await withRunModule(model, async (module, runtime) => {
    const first = await module.run({
      message: "我叫小林",
      customer_id: "trusted-customer",
      request_id: "request-1",
    });
    const second = await module.run({
      message: "我刚才说我叫什么？",
      session_id: first.session_id,
      customer_id: "trusted-customer",
      request_id: "request-2",
    });

    assert.equal(first.status, "responded");
    assert.equal(second.session_id, first.session_id);
    assert.match(JSON.stringify(model.requests[1]?.input), /我叫小林/);
    assert.match(JSON.stringify(model.requests[1]?.input), /你好，小林/);
    assert.deepEqual(
      (await module.sessionMessages(first.session_id, "trusted-customer")).map(
        (item) => item.role,
      ),
      ["user", "assistant", "user", "assistant"],
    );
    const trace = runtime.traces.get(second.trace_id);
    assert.equal(trace?.status, "completed");
    assert.equal(trace?.model_id, "typescript-scripted-model");
    assert.equal(trace?.business_outcome, "not_applicable");
    assert(runtime.traces.spanTypes(second.trace_id).includes("agent"));
  });
});

test("official TypeScript Runner executes the Model-selected business Tool", async () => {
  const model = new ScriptedModel([
    {
      type: "tool",
      callId: "call-create-order",
      name: "create_order",
      arguments: {
        idempotency_key: "customer-request-1",
        product_id: "SUIT-001",
        size: "L",
        fulfillment_mode: "rental",
        quantity: 1,
        start_date: "2026-08-01",
        end_date: "2026-08-03",
        amount_cents: 76_000,
        channel: "Chatty",
        address: "上海市静安区",
        risk: "无",
      },
    },
    { type: "message", id: "message-order", text: "订单已创建，等待确认。" },
  ]);
  await withRunModule(model, async (module, runtime) => {
    const result = await module.run({
      message: "请预订 8 月 1 日到 3 日的 L 码西装",
      customer_id: "trusted-customer",
      request_id: "request-order",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.business_outcome, "verified");
    assert.match(
      result.completion_evidence ?? "",
      /^create_order:order_.*:pending$/,
    );
    assert.equal(
      runtime.commerce.listOrders()[0]?.customer_id,
      "trusted-customer",
    );
    assert.match(
      JSON.stringify(model.requests[1]?.input),
      /function_call_result/,
    );
    assert(runtime.traces.spanTypes(result.trace_id).includes("function"));
  });
});

test("empty SDK final output is recovered as a persisted Handoff", async () => {
  const model = new ScriptedModel([
    { type: "message", id: "message-empty", text: "" },
  ]);
  await withRunModule(model, async (module, runtime) => {
    const result = await module.run({
      message: "你好",
      customer_id: "trusted-customer",
      request_id: "request-empty",
    });
    assert.equal(result.status, "needs_human");
    assert.match(result.support_request_id ?? "", /^support_/);
    assert.equal(runtime.support.listAll().length, 1);
  });
});

test("provider-specific invalid Agent output is recovered as a Handoff", async () => {
  class InvalidAgentOutputError extends Error {}
  class InvalidOutputModel implements Model {
    async getResponse(): Promise<ModelResponse> {
      throw new InvalidAgentOutputError("provider returned invalid output");
    }

    getStreamedResponse(): AsyncIterable<StreamEvent> {
      throw new Error("streaming is not used by deterministic tests");
    }
  }

  await withRunModule(new InvalidOutputModel(), async (module, runtime) => {
    const result = await module.run({
      message: "立即创建订单，但不提供必填信息。",
      customer_id: "trusted-customer",
      request_id: "request-invalid-output",
    });
    assert.equal(result.status, "needs_human");
    assert.match(result.support_request_id ?? "", /^support_/);
    assert.equal(runtime.traces.get(result.trace_id)?.status, "completed");
  });
});
