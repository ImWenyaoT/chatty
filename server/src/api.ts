/**
 * HTTP 层：把 Chatty 的一轮对话暴露成 REST 接口。
 *
 * 会话状态保存在服务端内存，不写入 SQLite。每个 session 串行处理请求，
 * 避免并发轮次互相覆盖 ChattyContext。
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";

import {
  Chatty,
  ChattyError,
  createChattyContext,
  type ChattyAgent,
  type ChattyContext,
} from "./agent/chatty.ts";
import { Catalog } from "./data/catalog.ts";
import { ResponsesModelProvider, type ModelProvider } from "./model-provider.ts";
import { FRONTEND_DIST } from "./settings.ts";

export const DEMO_USERS = [
  {
    id: "user_active",
    label: "用户 A · 活跃型",
    display_name: "用户 A",
    profile_label: "活跃型",
  },
  {
    id: "user_budget",
    label: "用户 B · 价格敏感型",
    display_name: "用户 B",
    profile_label: "价格敏感型",
  },
  {
    id: "user_vip",
    label: "用户 C · 高价值型",
    display_name: "用户 C",
    profile_label: "高价值型",
  },
  {
    id: "user_new",
    label: "用户 D · 新客型",
    display_name: "用户 D",
    profile_label: "新客型",
  },
  {
    id: "user_churn",
    label: "用户 E · 流失风险型",
    display_name: "用户 E",
    profile_label: "流失风险型",
  },
] as const;

const DEMO_USER_IDS = new Set<string>(DEMO_USERS.map((user) => user.id));

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

type SessionState = {
  userId: string;
  context: ChattyContext;
  // tail 是这个 session 上一次处理的完成信号，用来把请求排成一条串行链。
  tail: Promise<void>;
};

/** 同一 session 串行处理，避免并发请求覆盖彼此的 context。 */
function runExclusive<T>(session: SessionState, task: () => Promise<T>): Promise<T> {
  const result = session.tail.then(task, task);
  session.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export type AppDependencies = {
  catalog?: Catalog;
  provider?: ModelProvider;
  chatty?: ChattyAgent;
};

export function createApp(dependencies: AppDependencies = {}) {
  const catalog = dependencies.catalog ?? new Catalog();
  const provider = dependencies.provider ?? new ResponsesModelProvider();
  const chatty = dependencies.chatty ?? new Chatty(catalog, provider);
  const sessions = new Map<string, SessionState>();

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
    const sessionId = `session_${crypto.randomUUID().replaceAll("-", "")}`;
    sessions.set(sessionId, {
      userId: body.data.user_id,
      context: createChattyContext(),
      tail: Promise.resolve(),
    });
    return c.json({ session_id: sessionId });
  });

  app.post("/api/sessions/:sessionId/turns", async (c) => {
    const session = sessions.get(c.req.param("sessionId"));
    if (session === undefined) return c.json({ detail: "session_not_found" }, 404);

    const body = turnSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ detail: "invalid_request" }, 422);

    return runExclusive(session, async () => {
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
