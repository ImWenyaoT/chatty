# 薄 React/Vite 前端（已取代）

- 状态：Superseded by ADR 0011（2026-07-21）
- 取代：ADR 0005、0007、0008 中的 Next.js 实现细节

该阶段的 `apps/web` 使用 React、TypeScript 和 Vite，不使用 Next.js。三个路由不需要 SSR、Server Components、Server Actions 或 Web 后端。Vite 负责开发与构建，并将同源 `/api/chatty` 代理到 FastAPI。

前端只显示 Agent/Harness 的状态。Playground、Dashboard 和 Orders 在单个视口内完成主任务。Playwright E2E 启动 Vite 和 FastAPI，并验证到 Agent/Harness 和 SQLite 的完整路径。
