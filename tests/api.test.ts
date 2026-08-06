/**
 * HTTP 契约：直接调用 Next 的 Route Handler。
 *
 * Route Handler 就是拿 Request 还 Response 的普通函数，所以不用起 server。
 * 依赖不再由 `createApp()` 注入，而是从 `lib/runtime.ts` 取，因此用
 * `__setRuntimeForTest()` 换掉需要的字段，并在 finally 里还原。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Usage } from "@openai/agents";

import { GET as getCatalogData } from "../src/app/api/catalog/data/route.ts";
import { GET as getCatalog } from "../src/app/api/catalog/route.ts";
import { POST as postSession } from "../src/app/api/sessions/route.ts";
import { POST as postTurn } from "../src/app/api/sessions/[sessionId]/turns/route.ts";
import { GET as getHealth } from "../src/app/api/health/route.ts";
import {
  Chatty,
  type ChattyAgent,
  type ChattyContext,
  type ChattyTurn,
} from "../src/agent/lib/chatty.ts";
import type { ModelProvider } from "../src/agent/lib/model-provider.ts";
import { Catalog } from "../src/data/catalog.ts";
import { DATA_DIR } from "../src/data/seed.ts";
import {
  __setRuntimeForTest,
  type ChattyRuntime,
} from "../src/server/runtime.ts";
import { SessionStore } from "../src/server/session-store.ts";
import { ScriptedModel } from "./helpers/scripted-model.ts";

const BASE = "http://localhost";

/**
 * 建一份只属于本用例的运行时并挂上去。
 *
 * 四个字段全部覆盖，`resolve()` 就不会去碰真实单例，也就不会读 `.env`。
 */
async function withRuntime(
  build: (catalog: Catalog) => Pick<ChattyRuntime, "provider" | "chatty">,
  body: () => Promise<void>,
): Promise<void> {
  const catalog = new Catalog(":memory:", DATA_DIR);
  const restore = __setRuntimeForTest({
    catalog,
    sessions: new SessionStore(),
    ...build(catalog),
  });
  try {
    await body();
  } finally {
    restore();
    catalog.close();
  }
}

function postRequest(path: string, body: string): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function createSession(payload: unknown): Promise<Response> {
  return postSession(postRequest("/api/sessions", JSON.stringify(payload)));
}

function createTurn(sessionId: string, payload: unknown): Promise<Response> {
  return postTurn(
    postRequest(`/api/sessions/${sessionId}/turns`, JSON.stringify(payload)),
    { params: Promise.resolve({ sessionId }) },
  );
}

async function openSession(userId = "user_active"): Promise<string> {
  const response = await createSession({ user_id: userId });
  assert.equal(response.status, 200);
  const { session_id: sessionId } = (await response.json()) as {
    session_id: string;
  };
  return sessionId;
}

function providerOf(configured: boolean): ModelProvider {
  return { agentModel: new ScriptedModel([]), configured, modelId: "scripted" };
}

function realChatty(configured: boolean) {
  return (catalog: Catalog) => {
    const provider = providerOf(configured);
    return { provider, chatty: new Chatty(catalog, provider) };
  };
}

describe("HTTP 契约", () => {
  it("健康检查、目录快照与会话校验", async () => {
    await withRuntime(realChatty(true), async () => {
      assert.deepStrictEqual(await getHealth().json(), { status: "ok" });

      const catalogResponse = getCatalog();
      assert.equal(catalogResponse.status, 200);
      const info = (await catalogResponse.json()) as { product_count: number };
      assert.ok(info.product_count > 0);

      const dataResponse = getCatalogData();
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

      const invalidUser = await createSession({ user_id: "missing" });
      assert.equal(invalidUser.status, 422);
      assert.deepStrictEqual(await invalidUser.json(), {
        detail: "unknown_user",
      });

      const sessionId = await openSession();

      const blank = await createTurn(sessionId, { text: "   " });
      assert.equal(blank.status, 422);
      assert.deepStrictEqual(await blank.json(), { detail: "invalid_request" });

      const malformed = await postSession(postRequest("/api/sessions", "{"));
      assert.equal(malformed.status, 422);
      assert.deepStrictEqual(await malformed.json(), {
        detail: "invalid_request",
      });

      const missing = await createTurn("session_missing", { text: "你好" });
      assert.equal(missing.status, 404);
      assert.deepStrictEqual(await missing.json(), {
        detail: "session_not_found",
      });

      // 请求体校验先于 session 查找：body 畸形时看不到 404。
      const malformedTurn = await postTurn(
        postRequest("/api/sessions/session_missing/turns", "{"),
        { params: Promise.resolve({ sessionId: "session_missing" }) },
      );
      assert.equal(malformedTurn.status, 422);
      assert.deepStrictEqual(await malformedTurn.json(), {
        detail: "invalid_request",
      });
    });
  });

  it("缺少凭据时返回稳定错误码", async () => {
    await withRuntime(realChatty(false), async () => {
      const sessionId = await openSession();

      const response = await createTurn(sessionId, {
        text: "我要一个 200 元的蓝牙耳机",
      });
      assert.equal(response.status, 422);
      assert.deepStrictEqual(await response.json(), {
        detail: "llm_not_configured",
      });
    });
  });

  it("HTTP 适配层通过单一 run 接口调用 Chatty", async () => {
    const calls: [string, string, ChattyContext][] = [];
    const fakeChatty: ChattyAgent = {
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

    await withRuntime(
      () => ({ provider: providerOf(true), chatty: fakeChatty }),
      async () => {
        const sessionId = await openSession();

        const response = await createTurn(sessionId, {
          text: "给我一个 200 元的蓝牙耳机",
        });

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
    const fakeChatty: ChattyAgent = {
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

    await withRuntime(
      () => ({ provider: providerOf(true), chatty: fakeChatty }),
      async () => {
        const sessionId = await openSession();

        await Promise.all(
          ["第一轮", "第二轮", "第三轮"].map((text) =>
            createTurn(sessionId, { text }),
          ),
        );

        assert.equal(maxActive, 1);
      },
    );
  });
});
