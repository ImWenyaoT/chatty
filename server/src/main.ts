import { serve } from "@hono/node-server";

import { createApp, mountFrontend } from "./api.ts";
import { loadSettings } from "./settings.ts";

const settings = loadSettings();
const app = createApp();
mountFrontend(app);

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: settings.port }, (info) => {
  console.log(`Chatty API listening on http://127.0.0.1:${info.port}`);
});
