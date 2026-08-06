import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Chatty,
  ChattyError,
  createChattyContext,
} from "../agent/lib/chatty.ts";
import { createEvidence } from "../agent/lib/evidence.ts";
import {
  ChattyExecutor,
  RecommendationError,
  buildChattyAgent,
  prepareRecommendationContext,
  prepareTaskContext,
} from "../agent/lib/executor.ts";
import { Catalog } from "../data/catalog.ts";
import { DATA_DIR } from "../data/seed.ts";
import { emptyUserContext } from "../data/models.ts";
import type { ModelProvider } from "../agent/lib/model-provider.ts";
import {
  ScriptedModel,
  textOutput,
  toolCalls,
} from "./helpers/scripted-model.ts";

async function withCatalog<T>(
  body: (catalog: Catalog) => T | Promise<T>,
): Promise<T> {
  const catalog = new Catalog(":memory:", DATA_DIR);
  try {
    return await body(catalog);
  } finally {
    catalog.close();
  }
}

function providerOf(model: ScriptedModel): ModelProvider {
  return { agentModel: model, configured: true, modelId: "scripted" };
}

const TASK_FRAME_KNOWLEDGE = JSON.stringify({
  product_requested: false,
  category: [],
  min_yuan: [],
  max_yuan: [],
  knowledge_query: ["快递公司"],
});

describe("Harness 准备确定性 Context", () => {
  it("画像、搜索与库存由 Harness 顺序执行", async () => {
    await withCatalog((catalog) => {
      const evidence = createEvidence();
      const context = prepareRecommendationContext(
        {
          user_id: "user_active",
          num_items: 3,
          context: {
            ...emptyUserContext(),
            preferred_categories: ["耳机"],
            max_price_cents: 20_000,
          },
        },
        catalog,
        evidence,
      );

      assert.equal(context.profile.user_id, "user_active");
      assert.deepStrictEqual(evidence.used_tools, [
        "get_user_profile",
        "search_products",
        "check_inventory",
      ]);
      // 20000 分上限下没有匹配的耳机，Harness 仍然完整跑完三个步骤。
      assert.deepStrictEqual(context.candidates, []);
      assert.deepStrictEqual(context.inventory, []);
    });
  });

  it("纯知识问答只要求知识检索", async () => {
    await withCatalog((catalog) => {
      const evidence = createEvidence();
      prepareTaskContext(
        { product_need: null, knowledge_query: "退货政策" },
        "user_active",
        catalog,
        evidence,
      );

      assert.deepStrictEqual(evidence.required_support_tools, [
        "retrieve_knowledge",
      ]);
      assert.deepStrictEqual(evidence.required_knowledge_scopes, ["general"]);
    });
  });
});

describe("主 Agent 契约", () => {
  it("声明结构化输出与两个 Tool", () => {
    const agent = buildChattyAgent(providerOf(new ScriptedModel([])));

    assert.deepStrictEqual(
      agent.tools.map((tool) => tool.name),
      ["retrieve_knowledge", "get_marketing_strategy"],
    );
    assert.equal(agent.modelSettings.toolChoice, "required");
  });
});

describe("Chatty 端到端", () => {
  it("知识问答完成一轮 Context In / Context Out", async () => {
    const model = new ScriptedModel([
      textOutput(TASK_FRAME_KNOWLEDGE),
      toolCalls([
        {
          callId: "call_1",
          name: "retrieve_knowledge",
          args: { query: "快递公司", limit: 3, scope: "general" },
        },
      ]),
      textOutput(
        JSON.stringify({
          action: "answer",
          answer: "默认使用合作快递发货。",
          question: null,
          recommendations: null,
        }),
      ),
    ]);

    await withCatalog(async (catalog) => {
      const chatty = new Chatty(catalog, providerOf(model));
      const turn = await chatty.run(
        "user_active",
        "用什么快递发货",
        createChattyContext(),
      );

      assert.deepStrictEqual(turn.reply, {
        kind: "answer",
        answer: "默认使用合作快递发货。",
      });
      assert.equal(turn.understoodAs, "知识 · 快递公司");
      assert.deepStrictEqual(turn.trace, [
        "task_framing",
        "retrieve_knowledge",
        "response_generation",
        "evidence_validation",
      ]);
      assert.equal(turn.turnsLeft, 2);
      // 完成回答后会话状态清空，不再带入下一轮。
      assert.deepStrictEqual(turn.context.pendingUserMessages, []);
      assert.deepStrictEqual(turn.context.history, []);
      assert.equal(turn.usage.requests, 3);
    });
  });

  it("阶段外的 Tool 调用被门禁拦截并要求纠正", async () => {
    const model = new ScriptedModel([
      textOutput(TASK_FRAME_KNOWLEDGE),
      // 纯知识问答不需要营销策略，这次调用应当被拒绝且不执行。
      toolCalls([
        { callId: "call_1", name: "get_marketing_strategy", args: {} },
        {
          callId: "call_2",
          name: "retrieve_knowledge",
          args: { query: "快递公司", limit: 3, scope: "general" },
        },
      ]),
      textOutput(
        JSON.stringify({
          action: "answer",
          answer: "默认使用合作快递发货。",
          question: null,
          recommendations: null,
        }),
      ),
    ]);

    await withCatalog(async (catalog) => {
      const chatty = new Chatty(catalog, providerOf(model));
      const turn = await chatty.run(
        "user_active",
        "用什么快递发货",
        createChattyContext(),
      );

      assert.equal(turn.reply.kind, "answer");
      // 被拦截的 Tool 不会进入 Trace。
      assert.deepStrictEqual(turn.trace, [
        "task_framing",
        "retrieve_knowledge",
        "response_generation",
        "evidence_validation",
      ]);
    });
  });

  it("未配置凭据时给出稳定错误码", async () => {
    await withCatalog(async (catalog) => {
      const chatty = new Chatty(catalog, {
        agentModel: new ScriptedModel([]),
        configured: false,
        modelId: "scripted",
      });
      await assert.rejects(
        chatty.run("user_active", "退货政策", createChattyContext()),
        (error: unknown) =>
          error instanceof ChattyError && error.code === "llm_not_configured",
      );
    });
  });

  it("澄清次数耗尽后不再调用模型", async () => {
    await withCatalog(async (catalog) => {
      const chatty = new Chatty(catalog, providerOf(new ScriptedModel([])));
      await assert.rejects(
        chatty.run("user_active", "退货政策", {
          pendingUserMessages: [],
          history: [],
          turns: 3,
        }),
        (error: unknown) =>
          error instanceof ChattyError &&
          error.code === "conversation_exhausted",
      );
    });
  });
});

describe("草稿收敛", () => {
  it("混合任务不能以纯知识回答收场", async () => {
    const model = new ScriptedModel([
      textOutput(
        JSON.stringify({
          action: "answer",
          answer: "七天内可退货",
          question: null,
          recommendations: null,
        }),
      ),
    ]);

    await withCatalog(async (catalog) => {
      const evidence = createEvidence();
      evidence.general_knowledge_hits = 1;
      const taskContext = prepareTaskContext(
        {
          product_need: { category: "耳机", min_yuan: null, max_yuan: 300 },
          knowledge_query: "七天无理由退货条件",
        },
        "user_active",
        catalog,
        evidence,
      );
      const executor = new ChattyExecutor(catalog, providerOf(model));

      await assert.rejects(
        executor.respond(taskContext, evidence, "推荐耳机并说明退货政策"),
        (error: unknown) =>
          error instanceof RecommendationError &&
          error.code === "invalid_draft",
      );
    });
  });

  it("provider 不遵守 Schema 时，用它自己的文本纠正一次", async () => {
    // 第一次返回不是 AgentDraft 的纯文本，SDK 判定 invalidFinalOutput；
    // 纠正 Agent 读到这段文本后给出合法草稿，整轮仍然成功。
    const model = new ScriptedModel([
      textOutput("我们和多家合作快递配送，订单发出后可在页面查看物流。"),
      textOutput(
        JSON.stringify({
          action: "answer",
          answer: "我们和多家合作快递配送，订单发出后可在页面查看物流。",
          question: null,
          recommendations: null,
        }),
      ),
    ]);

    await withCatalog(async (catalog) => {
      const evidence = createEvidence();
      evidence.general_knowledge_hits = 1;
      const taskContext = prepareTaskContext(
        { product_need: null, knowledge_query: "快递公司" },
        "user_active",
        catalog,
        evidence,
      );
      const executor = new ChattyExecutor(catalog, providerOf(model));

      const reply = await executor.respond(taskContext, evidence, "快递公司");

      assert.equal(reply.kind, "answer");
      assert.match(reply.answer, /合作快递/);
      // 纠正也调用了 Model，这次开销必须计入 Usage。
      assert.equal(evidence.usage.requests, 2);
    });
  });

  it("未知异常的诊断信息保留异常类型", async () => {
    // ScriptedModel 用尽后抛出的普通 Error 必须被折叠成稳定错误码。
    const model = new ScriptedModel([]);

    await withCatalog(async (catalog) => {
      const evidence = createEvidence();
      const taskContext = prepareTaskContext(
        { product_need: null, knowledge_query: "退货政策" },
        "user_active",
        catalog,
        evidence,
      );
      const executor = new ChattyExecutor(catalog, providerOf(model));

      await assert.rejects(
        executor.respond(taskContext, evidence, "退货政策"),
        (error: unknown) => {
          assert.ok(error instanceof RecommendationError);
          assert.equal(error.code, "recommendation_failed");
          assert.equal(error.diagnostics["cause"], "scripted_model_exhausted");
          return true;
        },
      );
    });
  });
});
