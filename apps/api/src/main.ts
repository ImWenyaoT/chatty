import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./api.ts";
import { loadSettings } from "./settings.ts";

const settings = loadSettings();
const app = createApp();

// 静态页面必须最后挂载，避免遮住 /api 和 /health。
const frontendDist = new URL("../../web/dist/", import.meta.url);
if (existsSync(frontendDist)) {
  const root = relative(process.cwd(), fileURLToPath(frontendDist));
  app.use("/*", serveStatic({ root }));
  app.get("/*", serveStatic({ root, path: "index.html" }));
} else {
  console.warn("frontend_dist_missing:", fileURLToPath(frontendDist));
}

serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port: settings.port },
  (info) => {
    console.log(`Chatty API listening on http://127.0.0.1:${info.port}`);
  },
);
