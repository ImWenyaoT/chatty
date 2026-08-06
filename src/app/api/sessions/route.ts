/** 开一段会话。会话状态只存服务端内存，不落 SQLite。 */

import { z } from "zod";

import { DEMO_USER_IDS } from "../../../data/demo-users.ts";
import { jsonError, parseJsonBody } from "../../../server/http.ts";
import { sessions } from "../../../server/runtime.ts";

const createSessionSchema = z.object({
  user_id: z.string().default("user_active"),
});

export async function POST(request: Request) {
  const body = await parseJsonBody(request, createSessionSchema);
  if (!body.ok) return jsonError("invalid_request", 422);
  if (!DEMO_USER_IDS.has(body.data.user_id)) {
    return jsonError("unknown_user", 422);
  }
  return Response.json({ session_id: sessions.create(body.data.user_id) });
}
