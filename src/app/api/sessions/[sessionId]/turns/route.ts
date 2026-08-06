/**
 * 一轮对话。
 *
 * 字段名保持 snake_case，跟前端和 SQLite 列名一致。
 */

import { z } from "zod";

import { ChattyError } from "../../../../../agent/lib/chatty.ts";
import { jsonError, parseJsonBody } from "../../../../../server/http.ts";
import { chatty, sessions } from "../../../../../server/runtime.ts";

const turnSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(500)
    .transform((value) => value.trim())
    .refine((value) => value.length > 0),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  // 请求体先于 session 校验，与原契约的 validator 顺序一致。
  const body = await parseJsonBody(request, turnSchema);
  if (!body.ok) return jsonError("invalid_request", 422);

  const { sessionId } = await context.params;
  const session = sessions.get(sessionId);
  if (session === undefined) return jsonError("session_not_found", 404);

  // 一轮里有多个 await 点，同一 session 的并发请求必须排队，否则会互相覆盖 Context。
  return sessions.runExclusive(session, async () => {
    let turn;
    try {
      turn = await chatty.run(session.userId, body.data.text, session.context);
    } catch (error) {
      if (!(error instanceof ChattyError)) throw error;
      console.error(error.code, error.diagnostics);
      const status = error.code === "conversation_exhausted" ? 409 : 422;
      return Response.json({ detail: error.code }, { status });
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
      return Response.json({
        ...common,
        kind: "answer" as const,
        question: null,
        products: [],
      });
    }
    if (turn.reply.kind === "clarify") {
      return Response.json({
        ...common,
        kind:
          turn.turnsLeft === 0 ? ("exhausted" as const) : ("clarify" as const),
        question: turn.reply.question,
        products: [],
      });
    }
    return Response.json({
      ...common,
      kind: "recommend" as const,
      question: null,
      products: turn.reply.products,
    });
  });
}
