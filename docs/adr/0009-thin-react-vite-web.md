# 薄 React/Vite 前端

- 状态：Accepted（2026-07-20）
- 取代：ADR 0005、0007、0008 中的 Next.js 实现细节

`apps/web` 使用 React、TypeScript 与 Vite，不使用 Next.js。当前三个路由不需要 SSR、Server Components、Server Actions 或 web 后端；Vite 只负责开发与构建，并将同源 `/api/chatty` 代理到 FastAPI。

前端保持为 Agent/Harness 的薄可视化层：Playground、Dashboard 和 Orders 优先在单个视口内完成主任务，局部内容可滚动，次要功能收入导航。Playwright E2E 启动 Vite 开发服务，继续验证真实 FastAPI、Agent/Harness 与 SQLite 路径。
