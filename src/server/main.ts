import { serve } from "@hono/node-server";

import { app } from "./app.ts";
import { loadSettings } from "./settings.ts";

const settings = loadSettings();

// 可选：单独跑 Hono（不含 Next 页面）。主路径是 `pnpm dev` → Next :3000。
serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port: settings.port },
  (info) => {
    console.log(`Chatty API listening on http://127.0.0.1:${info.port}`);
  },
);
