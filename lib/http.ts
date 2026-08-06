/**
 * Route Handler 共用的请求解析与错误响应。
 *
 * 契约里「请求体不合法」只有一个码：JSON 解析失败和 Schema 不过都是 422 invalid_request。
 * 两者放在一个函数里，避免两个 route 各写一遍再走偏。
 */

import type { z } from "zod";

export function jsonError(detail: string, status: number): Response {
  return Response.json({ detail }, { status });
}

type ParsedBody<T> = { ok: true; data: T } | { ok: false };

export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<ParsedBody<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // 空 body 或畸形 JSON。这里必须自己接住，否则会变成 500。
    return { ok: false };
  }
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}
