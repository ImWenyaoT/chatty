import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import { z } from "zod";
import { Catalog } from "./catalog.js";
import { ROOT } from "./config.js";
import { Recommender, RecommendationError } from "./agent.js";
import { Conversation } from "./conversation.js";
import { describe, parseNeed } from "./need-parser.js";
import {
  ResponsesModelProvider,
  type ModelProvider,
} from "./model-provider.js";
import { emptyContext, isClarify, type InputItem } from "./types.js";
export const DEMO_USERS = [
  "user_active",
  "user_budget",
  "user_vip",
  "user_new",
  "user_churn",
];
const MAX_TURNS = 3;
interface Session {
  userId: string;
  said: string[];
  history: InputItem[];
  turns: number;
}
export interface Deps {
  catalog: Catalog;
  provider: ModelProvider;
  sessions: Map<string, Session>;
}
export function createApp(injected: Partial<Deps> = {}): Express {
  const catalog = injected.catalog ?? new Catalog();
  const provider = injected.provider ?? new ResponsesModelProvider();
  const sessions = injected.sessions ?? new Map<string, Session>();
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/catalog", (_req, res) =>
    res.json({
      categories: catalog.categories,
      users: DEMO_USERS,
      product_count: catalog.products.length,
      model_id: provider.modelId,
    }),
  );
  app.post("/api/sessions", (req, res) => {
    const parsed = z
      .object({ user_id: z.string().default("user_active") })
      .safeParse(req.body);
    if (!parsed.success || !DEMO_USERS.includes(parsed.data.user_id)) {
      res.status(422).json({ detail: "unknown_user" });
      return;
    }
    const id = `session_${crypto.randomUUID().replaceAll("-", "")}`;
    sessions.set(id, {
      userId: parsed.data.user_id,
      said: [],
      history: [],
      turns: 0,
    });
    res.json({ session_id: id, user_id: parsed.data.user_id });
  });
  app.post("/api/sessions/:id/turns", async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ detail: "session_not_found" });
      return;
    }
    if (session.turns >= MAX_TURNS) {
      res.status(409).json({ detail: "conversation_exhausted" });
      return;
    }
    const parsed = z
      .object({ text: z.string().trim().min(1).max(500) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ detail: "invalid_request" });
      return;
    }
    const said = [...session.said, parsed.data.text];
    let understood = emptyContext();
    const resolve = async (values: string[]) => {
      understood = await parseNeed(
        provider,
        values.join(" "),
        catalog.categories,
      );
      return understood;
    };
    try {
      const [reply, history] = await new Conversation(
        new Recommender(catalog, provider),
        session.userId,
        resolve,
        MAX_TURNS,
      ).send(said, session.history);
      session.said = said;
      session.history = history;
      session.turns += 1;
      const turnsLeft = MAX_TURNS - session.turns;
      res.json(
        isClarify(reply)
          ? {
              kind: turnsLeft ? "clarify" : "exhausted",
              understood_as: describe(understood),
              question: reply.question,
              products: [],
              latency_ms: reply.total_latency_ms,
              turns_left: turnsLeft,
            }
          : {
              kind: "recommend",
              understood_as: describe(understood),
              question: null,
              products: reply.products,
              latency_ms: reply.total_latency_ms,
              turns_left: turnsLeft,
            },
      );
    } catch (error) {
      res.status(422).json({
        detail:
          error instanceof RecommendationError
            ? error.code
            : "recommendation_failed",
      });
    }
  });
  const webDist = path.join(ROOT, "web", "dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/.*/, (_req, res) =>
      res.sendFile(path.join(webDist, "index.html")),
    );
  }
  return app;
}
