import { handle } from "hono/vercel";

import { app } from "../../src/server/app.ts";

export const runtime = "nodejs";

const handler = handle(app);

export const GET = handler;
