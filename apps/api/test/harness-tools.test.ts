import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeRecord } from "@chatty/contracts";
import {
  AgentContext,
  InvalidAgentOutputError,
  completeAgentRun,
  persistAgentRun,
} from "../src/harness.js";
import { NativeRuntime } from "../src/runtime.js";
import { executeChattyTool, type ToolExecutionState } from "../src/tools.js";

function withContext(
  run: (input: {
    context: AgentContext;
    runtime: NativeRuntime;
    state: ToolExecutionState;
  }) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "chatty-harness-"));
  const runtime = new NativeRuntime(join(directory, "chatty.sqlite"));
  runtime.traces.start("trace-1", "trusted-session", "test-model");
  const context = new AgentContext({
    customerId: "trusted-customer",
    sessionId: "trusted-session",
    message: "请记住我常穿 L 码上装",
    traceId: "trace-1",
    requestId: "request-1",
    commerce: runtime.commerce,
    artifactStore: runtime.artifacts,
    memoryStore: runtime.memory,
    supportStore: runtime.support,
    traceStore: runtime.traces,
  });
  const state = { knowledgeSearchResults: new Map<string, KnowledgeRecord>() };
  try {
    run({ context, runtime, state });
  } finally {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const buyout = {
  idempotency_key: "create-1",
  product_id: "SUIT-001",
  size: "L",
  fulfillment_mode: "buyout" as const,
  quantity: 3,
  start_date: null,
  end_date: null,
  amount_cents: 10_000,
  channel: "Chatty",
  address: "上海市静安区",
  risk: "无",
};

test("tools use Harness identity and reject Model-supplied identity", () => {
  withContext(({ context, runtime, state }) => {
    const rejected = JSON.parse(
      executeChattyTool(context, runtime.knowledge, state, "create_order", {
        ...buyout,
        customer_id: "attacker",
      }),
    ) as { ok: boolean; error: string };
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /unrecognized/i);
    assert.deepEqual(runtime.commerce.listOrders(), []);

    const created = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "create_order",
        buyout,
      ),
    ) as { ok: boolean; order: { id: string } };
    const order = runtime.commerce.getOrder(created.order.id);
    assert.equal(created.ok, true);
    assert.equal(order.customer_id, "trusted-customer");
    assert.equal(order.session_id, "trusted-session");
  });
});

test("a successful read cannot hide a failed mutation", () => {
  withContext(({ context, runtime, state }) => {
    const created = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "create_order",
        buyout,
      ),
    ) as { order: { id: string } };
    const orderInput = { order_id: created.order.id };
    const confirmation = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "confirm_order",
        orderInput,
      ),
    ) as { ok: boolean; error: string };
    executeChattyTool(
      context,
      runtime.knowledge,
      state,
      "view_order",
      orderInput,
    );

    assert.equal(confirmation.ok, false);
    assert.equal(confirmation.error, "insufficient_inventory");
    assert.deepEqual(context.verifyBusinessOutcome(), [
      "not_completed",
      "confirm_order:insufficient_inventory",
    ]);
    const result = completeAgentRun(context, {
      finalOutput: "订单已确认。",
      interrupted: false,
      attemptedToolNames: ["create_order", "confirm_order", "view_order"],
      knowledgeSearchResults: state.knowledgeSearchResults,
    });
    assert.equal(result.reply, "业务操作未完成：insufficient_inventory");
  });
});

test("memory tools require verbatim customer facts and preserve trace provenance", () => {
  withContext(({ context, runtime, state }) => {
    const saved = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "save_customer_memory",
        { fact: "常穿 L 码上装", explicitly_stated: true, stable: true },
      ),
    ) as { memories: Array<{ source_id: string }> };
    assert.equal(saved.memories[0]?.source_id, "trace-1");
    assert.throws(() =>
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "save_customer_memory",
        { fact: "推断客户偏好红色", explicitly_stated: true, stable: true },
      ),
    );
    assert.equal(context.priorActions.at(-1), "save_customer_memory:failed");
  });
});

test("completion requires knowledge source evidence", () => {
  withContext(({ context, state }) => {
    state.knowledgeSearchResults.set("policy-1", {
      id: "policy-1",
      title: "租期",
      summary: "租期规则",
      body: "从签收日开始",
      source: "seller-policy://rental-period",
      tags: [],
    });
    assert.throws(
      () =>
        completeAgentRun(context, {
          finalOutput: "租期从签收日开始。",
          interrupted: false,
          attemptedToolNames: ["search_knowledge"],
          knowledgeSearchResults: state.knowledgeSearchResults,
        }),
      InvalidAgentOutputError,
    );
    assert.equal(
      completeAgentRun(context, {
        finalOutput: "租期从签收日开始。来源：seller-policy://rental-period",
        interrupted: false,
        attemptedToolNames: ["search_knowledge"],
        knowledgeSearchResults: state.knowledgeSearchResults,
      }).business_outcome,
      "not_applicable",
    );
  });
});

test("empty output forces and persists a traceable handoff", () => {
  withContext(({ context, runtime, state }) => {
    const result = completeAgentRun(context, {
      finalOutput: "",
      interrupted: false,
      attemptedToolNames: [],
      knowledgeSearchResults: state.knowledgeSearchResults,
    });
    persistAgentRun(context, result);
    assert.equal(result.business_outcome, "not_completed");
    assert.match(result.support_request_id ?? "", /^support_/);
    assert.equal(
      result.completion_evidence,
      `handoff:${result.support_request_id}`,
    );
    assert.equal(runtime.support.listAll().length, 1);
    assert.equal(
      runtime.traces.get("trace-1")?.support_request_id,
      result.support_request_id,
    );
  });
});

test("research artifact accepts only sources searched in the current Agent run", () => {
  withContext(({ context, runtime, state }) => {
    state.knowledgeSearchResults.set("demo-industry-map", {
      id: "demo-industry-map",
      title: "高精地图产业链演示资料",
      summary: "高精地图连接定位、地图更新与智能驾驶应用。",
      body: "仅用于 Chatty 本地演示。",
      source: "demo://industry/high-definition-map",
      tags: ["industry"],
    });
    const base = {
      idempotency_key: "research-1",
      title: "高精地图产业研究简报",
      summary: "基于演示资料生成。",
      nodes: [],
      relations: [],
      unknowns: ["没有实时市场规模"],
    };

    const rejected = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "save_research_artifact" as never,
        {
          ...base,
          claims: [
            {
              id: "claim-unsupported",
              text: "未经检索的市场结论",
              source_ids: ["not-searched"],
            },
          ],
        },
      ),
    ) as { ok: boolean; error: string };
    assert.deepEqual(rejected, {
      ok: false,
      error: "artifact_source_not_searched:not-searched",
    });
    assert.deepEqual(runtime.artifacts.list("trusted-customer"), []);

    const saved = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "save_research_artifact" as never,
        {
          ...base,
          claims: [
            {
              id: "claim-position",
              text: "高精地图连接定位、地图更新与智能驾驶应用。",
              source_ids: ["demo-industry-map"],
            },
          ],
        },
      ),
    ) as {
      ok: boolean;
      artifact: { id: string; status: string };
      review: { passed: boolean };
    };
    assert.equal(saved.ok, true);
    assert.equal(saved.review.passed, true);
    assert.equal(saved.artifact.status, "review_pending");

    const result = completeAgentRun(context, {
      finalOutput: "研究简报已保存。来源：demo://industry/high-definition-map",
      interrupted: false,
      attemptedToolNames: ["search_knowledge", "save_research_artifact"],
      knowledgeSearchResults: state.knowledgeSearchResults,
    });
    assert.equal(result.business_outcome, "verified");
    assert.equal(
      result.completion_evidence,
      `artifact:${saved.artifact.id}:review_pending`,
    );
  });
});

test("content stays grounded in reviewed research and exports only after trusted approval", () => {
  withContext(({ context, runtime, state }) => {
    state.knowledgeSearchResults.set("demo-industry-map", {
      id: "demo-industry-map",
      title: "高精地图产业链演示资料",
      summary: "高精地图连接定位、地图更新与智能驾驶应用。",
      body: "仅用于 Chatty 本地演示。",
      source: "demo://industry/high-definition-map",
      tags: ["industry"],
    });
    const researchResult = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "save_research_artifact",
        {
          idempotency_key: "research-for-content",
          title: "高精地图产业研究简报",
          summary: "基于演示资料生成。",
          claims: [
            {
              id: "claim-position",
              text: "高精地图连接定位、地图更新与智能驾驶应用。",
              source_ids: ["demo-industry-map"],
            },
          ],
          nodes: [],
          relations: [],
          unknowns: [],
        },
      ),
    ) as { artifact: { id: string } };

    const contentResult = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "save_content_artifact" as never,
        {
          idempotency_key: "content-1",
          research_artifact_id: researchResult.artifact.id,
          title: "高精地图内容包",
          channels: [
            {
              channel: "xiaohongshu",
              title: "高精地图如何支持智能驾驶",
              body: "从定位与地图更新理解这项基础能力。",
              claim_ids: ["claim-position"],
            },
          ],
        },
      ),
    ) as {
      ok: boolean;
      artifact: { id: string; status: string };
      review: { passed: boolean };
    };
    assert.equal(contentResult.ok, true);
    assert.equal(contentResult.review.passed, true);
    assert.equal(contentResult.artifact.status, "review_pending");

    const blocked = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "export_artifact" as never,
        { artifact_id: contentResult.artifact.id, target: "sandbox" },
      ),
    ) as { ok: boolean; error: string };
    assert.deepEqual(blocked, {
      ok: false,
      error: "artifact_not_approved",
    });

    runtime.artifacts.approve(
      contentResult.artifact.id,
      "trusted-reviewer",
      "trusted-customer",
    );
    const exported = JSON.parse(
      executeChattyTool(
        context,
        runtime.knowledge,
        state,
        "export_artifact" as never,
        { artifact_id: contentResult.artifact.id, target: "sandbox" },
      ),
    ) as {
      ok: boolean;
      delivery: { id: string; content_hash: string };
    };
    assert.equal(exported.ok, true);
    assert.match(exported.delivery.id, /^delivery_/);

    const result = completeAgentRun(context, {
      finalOutput:
        "内容已导出到沙箱。来源：demo://industry/high-definition-map",
      interrupted: false,
      attemptedToolNames: [
        "search_knowledge",
        "save_research_artifact",
        "save_content_artifact",
        "export_artifact",
      ],
      knowledgeSearchResults: state.knowledgeSearchResults,
    });
    assert.equal(result.business_outcome, "verified");
    assert.equal(
      result.completion_evidence,
      `delivery:${exported.delivery.id}:${exported.delivery.content_hash}`,
    );
  });
});

test("completion rejects an unpersisted delivery evidence string", () => {
  withContext(({ context }) => {
    context.businessReceipts.push({
      tool_name: "export_artifact",
      ok: true,
      order_id: null,
      expected_status: null,
      artifact_id: null,
      expected_artifact_status: null,
      delivery_id: "forged-delivery",
      expected_content_hash: "forged-hash",
      evidence: null,
      error: null,
    });

    assert.throws(() => context.verifyBusinessOutcome());
  });
});
