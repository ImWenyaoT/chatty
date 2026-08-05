import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Usage } from "@openai/agents";

import type { ChattyContext, ChattyTurn } from "../src/agent/chatty.ts";
import { createApp } from "../src/api.ts";
import { Catalog } from "../src/data/catalog.ts";
import { DATA_DIR } from "@chatty/seed-data";
import type { ModelProvider } from "../src/model-provider.ts";
import { ScriptedModel } from "./helpers/scripted-model.ts";

const BASE = "http://localhost";

async function withApp(
  build: (catalog: Catalog) => ReturnType<typeof createApp>,
  body: (
    request: (path: string, init?: RequestInit) => Promise<Response>,
  ) => Promise<void>,
): Promise<void> {
  const catalog = new Catalog(":memory:", DATA_DIR);
  try {
    const app = build(catalog);
    await body(async (path, init) => app.request(`${BASE}${path}`, init));
  } finally {
    catalog.close();
  }
}

function postJson(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function providerOf(configured: boolean): ModelProvider {
  return { agentModel: new ScriptedModel([]), configured, modelId: "scripted" };
}

describe("HTTP 契约", () => {
  it("健康检查、目录快照与会话校验", async () => {
    await withApp(
      (catalog) => createApp({ catalog, provider: providerOf(true) }),
      async (request) => {
        assert.deepStrictEqual(await (await request("/health")).json(), {
          status: "ok",
        });

        const catalogResponse = await request("/api/catalog");
        assert.equal(catalogResponse.status, 200);
        const info = (await catalogResponse.json()) as {
          product_count: number;
        };
        assert.ok(info.product_count > 0);

        const dataResponse = await request("/api/catalog/data");
        assert.equal(dataResponse.status, 200);
        const data = (await dataResponse.json()) as {
          products: { product_id: string }[];
          profiles: {
            user_id: string;
            display_name: string;
            profile_label: string;
          }[];
        };
        assert.equal(data.products.length, info.product_count);
        assert.equal(data.products[0]?.product_id, "P001");
        assert.equal(data.profiles.length, 5);
        assert.deepStrictEqual(
          [
            data.profiles[0]?.user_id,
            data.profiles[0]?.display_name,
            data.profiles[0]?.profile_label,
          ],
          ["user_active", "用户 A", "活跃型"],
        );

        const invalidUser = await request(
          "/api/sessions",
          postJson({ user_id: "missing" }),
        );
        assert.equal(invalidUser.status, 422);
        assert.deepStrictEqual(await invalidUser.json(), {
          detail: "unknown_user",
        });

        const session = await request(
          "/api/sessions",
          postJson({ user_id: "user_active" }),
        );
        assert.equal(session.status, 200);
        const { session_id: sessionId } = (await session.json()) as {
          session_id: string;
        };

        const blank = await request(
          `/api/sessions/${sessionId}/turns`,
          postJson({ text: "   " }),
        );
        assert.equal(blank.status, 422);
        assert.deepStrictEqual(await blank.json(), {
          detail: "invalid_request",
        });

        const missing = await request(
          "/api/sessions/session_missing/turns",
          postJson({ text: "你好" }),
        );
        assert.equal(missing.status, 404);
        assert.deepStrictEqual(await missing.json(), {
          detail: "session_not_found",
        });
      },
    );
  });

  it("缺少凭据时返回稳定错误码", async () => {
    await withApp(
      (catalog) => createApp({ catalog, provider: providerOf(false) }),
      async (request) => {
        const { session_id: sessionId } = (await (
          await request("/api/sessions", postJson({ user_id: "user_active" }))
        ).json()) as { session_id: string };

        const response = await request(
          `/api/sessions/${sessionId}/turns`,
          postJson({ text: "我要一个 200 元的蓝牙耳机" }),
        );
        assert.equal(response.status, 422);
        assert.deepStrictEqual(await response.json(), {
          detail: "llm_not_configured",
        });
      },
    );
  });

  it("HTTP 适配层通过单一 run 接口调用 Chatty", async () => {
    const calls: [string, string, ChattyContext][] = [];
    const fakeChatty = {
      async run(
        userId: string,
        text: string,
        context: ChattyContext,
      ): Promise<ChattyTurn> {
        calls.push([userId, text, structuredClone(context)]);
        return {
          reply: {
            kind: "clarify",
            question: "预算可以提高吗？",
            answer: null,
          },
          understoodAs: "耳机 · ≤200 元",
          context: { pendingUserMessages: [text], history: [], turns: 1 },
          turnsLeft: 2,
          trace: ["task_framing", "evidence_validation"],
          usage: new Usage(),
          latencyMs: 1,
        };
      },
    };

    await withApp(
      (catalog) =>
        createApp({ catalog, provider: providerOf(true), chatty: fakeChatty }),
      async (request) => {
        const { session_id: sessionId } = (await (
          await request("/api/sessions", postJson({ user_id: "user_active" }))
        ).json()) as { session_id: string };

        const response = await request(
          `/api/sessions/${sessionId}/turns`,
          postJson({ text: "给我一个 200 元的蓝牙耳机" }),
        );

        assert.equal(response.status, 200);
        const turn = (await response.json()) as {
          kind: string;
          question: string;
        };
        assert.equal(turn.kind, "clarify");
        assert.equal(turn.question, "预算可以提高吗？");
        assert.deepStrictEqual(calls, [
          [
            "user_active",
            "给我一个 200 元的蓝牙耳机",
            { pendingUserMessages: [], history: [], turns: 0 },
          ],
        ]);
      },
    );
  });

  it("同一 session 的并发请求串行处理", async () => {
    let active = 0;
    let maxActive = 0;
    const fakeChatty = {
      async run(
        _userId: string,
        text: string,
        context: ChattyContext,
      ): Promise<ChattyTurn> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          reply: { kind: "answer", answer: text },
          understoodAs: text,
          context: { ...context, turns: context.turns + 1 },
          turnsLeft: 2,
          trace: [],
          usage: new Usage(),
          latencyMs: 1,
        };
      },
    };

    await withApp(
      (catalog) =>
        createApp({ catalog, provider: providerOf(true), chatty: fakeChatty }),
      async (request) => {
        const { session_id: sessionId } = (await (
          await request("/api/sessions", postJson({ user_id: "user_active" }))
        ).json()) as { session_id: string };

        await Promise.all(
          ["第一轮", "第二轮", "第三轮"].map((text) =>
            request(`/api/sessions/${sessionId}/turns`, postJson({ text })),
          ),
        );

        assert.equal(maxActive, 1);
      },
    );
  });
});
