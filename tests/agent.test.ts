import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  Chatty,
  ChattyError,
  createChattyContext,
} from "../src/agent/lib/chatty.ts";
import { createEvidence } from "../src/agent/lib/evidence.ts";
import { buildChattyAgent } from "../src/agent/agent.ts";
import { HOOK_NAMES } from "../src/agent/lib/hook-registry.ts";
import { MODEL_TOOL_NAMES } from "../src/agent/lib/tool-names.ts";
import { buildDraftCorrectionAgent } from "../src/agent/subagents/draft_corrector/agent.ts";
import { buildTaskFrameAgent } from "../src/agent/subagents/task_framer/agent.ts";
import {
  ChattyExecutor,
  RecommendationError,
  prepareRecommendationContext,
  prepareTaskContext,
} from "../src/agent/lib/executor.ts";
import { Catalog } from "../src/data/catalog.ts";
import { DATA_DIR } from "../src/data/seed.ts";
import {
  agentDraftSchema,
  buildAgentDraftSchema,
  emptyUserContext,
} from "../src/data/models.ts";
import type { ModelProvider } from "../src/agent/lib/model-provider.ts";
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
  category: null,
  min_yuan: null,
  max_yuan: null,
  knowledge_query: "快递公司",
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

  // 状态栏里的 allowed_final_action 是模型唯一能看到的输出契约。它一旦和
  // finalizeReply 的分支判据漂移，模型会照着错的那份走——所以判据锁在这里。
  it("allowed_final_actions 由是否存在商品需求决定", async () => {
    await withCatalog((catalog) => {
      const cases = [
        {
          name: "纯知识问答",
          frame: { product_need: null, knowledge_query: "退货政策" },
          expected: ["answer"],
        },
        {
          name: "纯商品推荐",
          frame: {
            product_need: { category: "耳机", min_yuan: null, max_yuan: 300 },
            knowledge_query: null,
          },
          expected: ["recommend", "clarify"],
        },
        {
          name: "混合请求仍然不能用 answer 收尾",
          frame: {
            product_need: { category: "耳机", min_yuan: null, max_yuan: 300 },
            knowledge_query: "七天无理由退货条件",
          },
          expected: ["recommend", "clarify"],
        },
      ];

      for (const testCase of cases) {
        const evidence = createEvidence();
        const context = prepareTaskContext(
          testCase.frame,
          "user_active",
          catalog,
          evidence,
        );
        assert.deepStrictEqual(
          evidence.allowed_final_actions,
          testCase.expected,
          testCase.name,
        );
        // finalizeReply 走的是 recommendation 是否为 null，两者必须同源。
        assert.equal(
          context.recommendation === null,
          testCase.expected.includes("answer"),
          `${testCase.name}：状态栏与 finalizeReply 判据漂移`,
        );
      }
    });
  });
});

describe("主 Agent 契约", () => {
  it("声明结构化输出与两个 Tool", () => {
    const agent = buildChattyAgent(providerOf(new ScriptedModel([])));

    // 顺序是 readdir 的字母序：Tool 清单由目录派生，没有第二处可以排序的注册表。
    assert.deepStrictEqual(
      agent.tools.map((tool) => tool.name),
      ["get_marketing_strategy", "retrieve_knowledge"],
    );
    assert.equal(agent.modelSettings.toolChoice, "required");
  });

  // 这条是「路径即身份」这个约定本身：目录里有几个文件，Agent 就有几个同名 Tool。
  // 加一个 .ts 文件就是加一个 Tool，删文件就是删 Tool，不需要改任何清单。
  it("Tool 名与 agent/tools/ 的文件名一一对应", () => {
    const agent = buildChattyAgent(providerOf(new ScriptedModel([])));
    const dir = fileURLToPath(new URL("../src/agent/tools/", import.meta.url));
    const fromDisk = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.slice(0, -".ts".length))
      .sort();

    assert.deepStrictEqual(
      agent.tools.map((tool) => tool.name).sort(),
      fromDisk,
    );
    assert.deepStrictEqual([...MODEL_TOOL_NAMES].sort(), fromDisk);
    // 名字既然由文件名派生，就不该有任何 Tool 文件自己写 name。
    for (const name of fromDisk) {
      const source = readFileSync(`${dir}${name}.ts`, "utf8");
      assert.ok(
        !/^\s*name:\s*"/m.test(source),
        `${name}.ts 不应写 name 字段，名字来自文件名`,
      );
    }
  });

  // 与 tools/ 对称：hooks/ 下每个文件都是一个 Hook，没有例外。guardrail 由 registry
  // 统一挂到所有 Tool 上，Tool 文件里不该再出现 inputGuardrails。
  it("Hook 名与 agent/hooks/ 的文件名一一对应，且 guardrail 由 registry 统一挂载", () => {
    const hooksDir = fileURLToPath(
      new URL("../src/agent/hooks/", import.meta.url),
    );
    const fromDisk = readdirSync(hooksDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.slice(0, -".ts".length))
      .sort();

    assert.deepStrictEqual([...HOOK_NAMES].sort(), fromDisk);
    assert.ok(fromDisk.length > 0, "hooks/ 不应为空");

    const agent = buildChattyAgent(providerOf(new ScriptedModel([])));
    for (const tool of agent.tools) {
      const guardrails =
        (tool as { inputGuardrails?: unknown[] }).inputGuardrails ?? [];
      assert.equal(guardrails.length, 1, `${tool.name} 应挂上 registry 的裁决`);
    }

    const toolsDir = fileURLToPath(
      new URL("../src/agent/tools/", import.meta.url),
    );
    for (const file of readdirSync(toolsDir)) {
      const source = readFileSync(`${toolsDir}${file}`, "utf8");
      assert.ok(
        !source.includes("inputGuardrails"),
        `${file} 不应自己声明 guardrail`,
      );
    }
  });

  // prompt 的真实内容必须就是 instructions.md 里看到的那份，一个字节都不差。
  // 这里不冻结副本——冻结副本会让每次改 prompt 都要同步两个文件。
  it("系统提示词逐字节来自 agent/instructions.md", () => {
    const agent = buildChattyAgent(providerOf(new ScriptedModel([])));
    const onDisk = readFileSync(
      fileURLToPath(new URL("../src/agent/instructions.md", import.meta.url)),
      "utf8",
    );

    assert.equal(typeof agent.instructions, "string");
    assert.equal(agent.instructions, onDisk);
    // 读取不做 trim，所以行首行尾的空白也必须原样保留。
    assert.ok(onDisk.endsWith("\n"), "instructions.md 应以换行结尾");
  });

  // Single Agent 的判据：只有一个 Agent 参与对话循环、持有历史、对用户可见。
  // subagent 由 Harness 确定性调用，绝不能作为 Tool 暴露给主 Agent——那才是 Multi-Agent。
  it("主 Agent 的 Tool 里不含任何 subagent", () => {
    const agent = buildChattyAgent(providerOf(new ScriptedModel([])));
    // 两个 subagent 名，外加 eve / Agents SDK 用来表示「委派」的通用 tool 名。
    const delegationToolNames = [
      "task_framer",
      "draft_corrector",
      "agent",
      "handoff",
    ];

    for (const tool of agent.tools) {
      assert.ok(
        !delegationToolNames.includes(tool.name),
        `${tool.name} 不应作为 Tool 暴露给主 Agent`,
      );
    }
    assert.deepStrictEqual(agent.handoffs ?? [], []);
  });
});

describe("输出契约收窄", () => {
  // 防呆：存在商品需求时，模型在解码阶段就发不出 answer，而不是发出来再被拒。
  it("收窄后的 schema 直接拒绝被禁的 action", () => {
    const narrowed = buildAgentDraftSchema(["recommend", "clarify"]);
    const draft = {
      action: "answer",
      answer: "七天内可退货",
      question: null,
      recommendations: null,
    };

    assert.equal(narrowed.safeParse(draft).success, false);
    // 同一份草稿在全量 schema 下是合法的——被拒是因为本轮取值范围收窄了。
    assert.equal(agentDraftSchema.safeParse(draft).success, true);
  });

  it("收窄不影响允许的 action 与既有跨字段规则", () => {
    const narrowed = buildAgentDraftSchema(["recommend", "clarify"]);

    assert.equal(
      narrowed.safeParse({
        action: "clarify",
        answer: null,
        question: "预算大概多少？",
        recommendations: null,
      }).success,
      true,
    );
    // clarify 仍然不能带推荐项，收窄没有绕过 superRefine。
    assert.equal(
      narrowed.safeParse({
        action: "clarify",
        answer: null,
        question: "预算大概多少？",
        recommendations: [
          { product_id: "P001", reason: "r", marketing_copy: "m" },
        ],
      }).success,
      false,
    );
  });
});

describe("Subagent 提示词", () => {
  const provider = providerOf(new ScriptedModel([]));

  function onDisk(relative: string): string {
    return readFileSync(
      fileURLToPath(
        new URL(`../src/agent/subagents/${relative}`, import.meta.url),
      ),
      "utf8",
    );
  }

  it("draft_corrector 逐字节来自 instructions.md", () => {
    assert.equal(
      buildDraftCorrectionAgent(provider).instructions,
      onDisk("draft_corrector/instructions.md"),
    );
  });

  // 这份是模板：唯一的动态位是 SQLite 里真实存在的类目。
  it("task_framer 只替换 {{categories}}，其余逐字节保留", () => {
    const template = onDisk("task_framer/instructions.md");
    const categories = ["耳机", "键盘"];
    const rendered = buildTaskFrameAgent(provider, categories).instructions;

    assert.ok(template.includes("{{categories}}"), "模板应保留占位符");
    assert.equal(rendered, template.replace("{{categories}}", "耳机、键盘"));
    assert.ok(!rendered.includes("{{"), "渲染后不应残留占位符");
  });

  // Subagent 的名字来自它自己的目录名。根 Agent 不在此列——它的名字按 eve 规范
  // 来自 package.json 的 name，而 SDK 要求 Agent 必填 name，这是路径决定身份的唯一例外。
  it("subagent 的名字等于它所在的目录名", () => {
    const dirs = readdirSync(
      fileURLToPath(new URL("../src/agent/subagents/", import.meta.url)),
    ).sort();

    assert.deepStrictEqual(dirs, ["draft_corrector", "task_framer"]);
    assert.equal(buildTaskFrameAgent(provider, ["耳机"]).name, "task_framer");
    assert.equal(buildDraftCorrectionAgent(provider).name, "draft_corrector");
  });

  it("subagent 提示词保持单行、无末尾换行", () => {
    for (const file of [
      "task_framer/instructions.md",
      "draft_corrector/instructions.md",
    ]) {
      assert.ok(!onDisk(file).includes("\n"), `${file} 应保持单行`);
    }
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
  // 存在商品需求时 answer 被两道防线挡住：主 Agent 的 outputType 收窄成
  // recommend/clarify，纠正 Agent 用同一份收窄 schema。两次都发 answer 就整轮失败。
  it("混合任务不能以纯知识回答收场", async () => {
    const answerDraft = JSON.stringify({
      action: "answer",
      answer: "七天内可退货",
      question: null,
      recommendations: null,
    });
    const model = new ScriptedModel([
      textOutput(answerDraft),
      textOutput(answerDraft),
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
