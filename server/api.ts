/**
 * HTTP 层：把 Chatty 的一轮对话暴露成 REST 接口。
 *
 * 字段名保持 snake_case，跟前端和 SQLite 列名一致。
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { Chatty, ChattyError, type ChattyAgent } from "../agent/lib/chatty.ts";
import { Catalog } from "../data/catalog.ts";
import { DEMO_USERS, DEMO_USER_IDS } from "../data/demo-users.ts";
import {
  ResponsesModelProvider,
  type ModelProvider,
} from "../agent/lib/model-provider.ts";
import { SessionStore } from "./session-store.ts";
import { loadSettings } from "./settings.ts";

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
  const provider =
    dependencies.provider ?? new ResponsesModelProvider(loadSettings());
  const chatty = dependencies.chatty ?? new Chatty(catalog, provider);
  const sessions = new SessionStore();

  const app = new Hono().onError((error, c) => {
    // zValidator 在 Schema 前先解析 JSON；解析失败也保持既有的稳定错误契约。
    if (error instanceof HTTPException && error.status === 400) {
      return c.json({ detail: "invalid_request" as const }, 422);
    }
    throw error;
  });

  return app
    .get("/health", (c) => c.json({ status: "ok" as const }))
    .get("/api/catalog", (c) =>
      c.json({
        categories: catalog.categories,
        users: DEMO_USERS,
        product_count: catalog.products.length,
        model_id: provider.modelId,
      }),
    )
    .get("/api/catalog/data", (c) =>
      c.json({
        products: catalog.products,
        profiles: DEMO_USERS.map((user) => ({
          ...catalog.userProfile(user.id),
          display_name: user.display_name,
          profile_label: user.profile_label,
        })),
      }),
    )
    .post(
      "/api/sessions",
      zValidator("json", createSessionSchema, (result, c) => {
        if (!result.success)
          return c.json({ detail: "invalid_request" as const }, 422);
      }),
      (c) => {
        const body = c.req.valid("json");
        if (!DEMO_USER_IDS.has(body.user_id)) {
          return c.json({ detail: "unknown_user" as const }, 422);
        }
        return c.json({ session_id: sessions.create(body.user_id) });
      },
    )
    .post(
      "/api/sessions/:sessionId/turns",
      zValidator("json", turnSchema, (result, c) => {
        if (!result.success)
          return c.json({ detail: "invalid_request" as const }, 422);
      }),
      async (c) => {
        const session = sessions.get(c.req.param("sessionId"));
        if (session === undefined) {
          return c.json({ detail: "session_not_found" as const }, 404);
        }
        const body = c.req.valid("json");

        return sessions.runExclusive(session, async () => {
          let turn;
          try {
            turn = await chatty.run(session.userId, body.text, session.context);
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
            return c.json({
              ...common,
              kind: "answer" as const,
              question: null,
              products: [],
            });
          }
          if (turn.reply.kind === "clarify") {
            return c.json({
              ...common,
              kind:
                turn.turnsLeft === 0
                  ? ("exhausted" as const)
                  : ("clarify" as const),
              question: turn.reply.question,
              products: [],
            });
          }
          return c.json({
            ...common,
            kind: "recommend" as const,
            question: null,
            products: turn.reply.products,
          });
        });
      },
    );
}

export type AppType = ReturnType<typeof createApp>;
