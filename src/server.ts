import { createApp } from "./api.js";
const port = Number(process.env.PORT ?? 8000);
export const server = createApp().listen(port, "127.0.0.1", () =>
  console.log(`Chatty API: http://127.0.0.1:${port}`),
);
