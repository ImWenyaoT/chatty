# Next.js、shadcn/ui 与 Tailwind CSS 前端

- 状态：部分被 ADR 0013 取代（2026-07-21）
- 取代：ADR 0009 的 Vite 构建与路由决定

`apps/web` 使用 Next.js App Router、TypeScript strict mode、shadcn/ui 和 Tailwind CSS v4。`/workbench` 是当前产品入口。根路径和旧的 `/playground`、`/orders`、`/dashboard` 路径都重定向到 Workbench。

Next.js 同时提供页面和 HTTP 入口。catch-all Route Handler 直接调用 `@chatty/agent` 的 HTTP application。它不复制 Model、Tool、SQLite、Session 或完成判断。Fastify 的删除记录见 [ADR-0012](0012-nextjs-agent-runtime.md)。

生产构建继续由 `pnpm --filter @chatty/web build` 生成，并通过 `pnpm --filter @chatty/web start` 启动。当前不启用 standalone 输出；若未来采用容器化 standalone 部署，须同时迁移启动入口并新增生产启动 smoke 后再切换。

shadcn/ui 组件以源码形式保存在 `src/components/ui`，配置由 `components.json` 固定为 Radix、Lucide、Tailwind v4 和 `@/components/ui` alias。组件更新必须先通过 CLI `--dry-run` 和 `--diff` 检查，不直接覆盖本地行为。
