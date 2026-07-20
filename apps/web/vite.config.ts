import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const chattyApiTarget =
  process.env.CHATTY_API_TARGET ?? "http://127.0.0.1:8000";

const chattyApiProxy = {
  "/api/chatty": {
    target: chattyApiTarget,
    rewrite: (path: string) => path.replace(/^\/api\/chatty/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    proxy: chattyApiProxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    proxy: chattyApiProxy,
  },
});
