import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发时把 /api 转给后端，前端代码里只写相对路径，不用配 base url，
    // 也就不会有一份「生产指哪、开发指哪」的环境变量要维护。
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
