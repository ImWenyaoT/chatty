/**
 * HTTP 层：把 Chatty 的一轮对话暴露成 REST 接口。
 *
 * 字段名保持 snake_case，跟前端和 SQLite 列名一致。
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";

import { Chatty, ChattyError, type ChattyAgent } from "./agent/chatty.ts";
import { Catalog } from "./data/catalog.ts";
import { DEMO_USERS, DEMO_USER_IDS } from "./data/demo-users.ts";
import { ResponsesModelProvider, type ModelProvider } from "./model-provider.ts";
import { FRONTEND_DIST } from "./paths.ts";
import { SessionStore } from "./session-store.ts";

const createSessionSchema = z.object({
  user_id: z.string().default("user_active"),
});

const turnSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(500)
    .transform((value) => value.trim())
    .refine((value) => value.length > 0),
});

export type AppDependencies = {
  catalog?: Catalog;
  provider?: ModelProvider;
  chatty?: ChattyAgent;
};

export function createApp(dependencies: AppDependencies = {}) {
  const catalog = dependencies.catalog ?? new Catalog();
  const provider = dependencies.provider ?? new ResponsesModelProvider();
  const chatty = dependencies.chatty ?? new Chatty(catalog, provider);
  const sessions = new SessionStore();

  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/api/catalog", (c) =>
    c.json({
      categories: catalog.categories,
      users: DEMO_USERS,
      product_count: catalog.products.length,
      model_id: provider.modelId,
    }),
  );

  /** 为 Demo 提供只读的 SQLite 商品与画像快照。 */
  app.get("/api/catalog/data", (c) =>
    c.json({
      products: catalog.products,
      profiles: DEMO_USERS.map((user) => ({
        ...catalog.profiles.get(user.id),
        display_name: user.display_name,
        profile_label: user.profile_label,
      })),
    }),
  );

  app.post("/api/sessions", async (c) => {
    const body = createSessionSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ detail: "invalid_request" }, 422);
    if (!DEMO_USER_IDS.has(body.data.user_id)) {
      return c.json({ detail: "unknown_user" }, 422);
    }
    const sessionId = sessions.create(body.data.user_id);
    return c.json({ session_id: sessionId });
  });

  app.post("/api/sessions/:sessionId/turns", async (c) => {
    const session = sessions.get(c.req.param("sessionId"));
    if (session === undefined) return c.json({ detail: "session_not_found" }, 404);

    const body = turnSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ detail: "invalid_request" }, 422);

    return sessions.runExclusive(session, async () => {
      let turn;
      try {
        turn = await chatty.run(session.userId, body.data.text, session.context);
      } catch (error) {
        if (!(error instanceof ChattyError)) throw error;
        console.error(error.code, error.diagnostics);
        const status = error.code === "conversation_exhausted" ? 409 : 422;
        return c.json({ detail: error.code }, status);
      }
      session.context = turn.context;

      // recommend / clarify / exhausted 共用这些观察字段，前端不再自行推导。
      const common = {
        understood_as: turn.understoodAs,
        answer: turn.reply.answer,
        latency_ms: turn.latencyMs,
        turns_left: turn.turnsLeft,
        trace: turn.trace,
        usage: {
          model_requests: turn.usage.requests,
          input_tokens: turn.usage.inputTokens,
          output_tokens: turn.usage.outputTokens,
          total_tokens: turn.usage.totalTokens,
        },
      };

      if (turn.reply.kind === "answer") {
        return c.json({ ...common, kind: "answer", question: null, products: [] });
      }
      if (turn.reply.kind === "clarify") {
        return c.json({
          ...common,
          kind: turn.turnsLeft === 0 ? "exhausted" : "clarify",
          question: turn.reply.question,
          products: [],
        });
      }
      return c.json({
        ...common,
        kind: "recommend",
        question: null,
        products: turn.reply.products,
      });
    });
  });

  return app;
}

/** 必须最后挂载，避免静态页面遮住 /api 和 /health。 */
export function mountFrontend(app: Hono): void {
  if (!existsSync(FRONTEND_DIST)) {
    console.warn("frontend_dist_missing:", fileURLToPath(FRONTEND_DIST));
    return;
  }
  // serveStatic 的 root 相对 process.cwd()。
  const root = relative(process.cwd(), fileURLToPath(FRONTEND_DIST));
  app.use("/*", serveStatic({ root }));
  app.get("/*", serveStatic({ root, path: "index.html" }));
}

/** 请求体不是合法 JSON 时按校验失败处理，而不是 500。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
