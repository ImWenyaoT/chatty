---
status: accepted
supersedes: 0006-typescript-ai-sdk
---

# 前端迁到 Next.js App Router + Astryx

## 背景

ADR 0006 把后端与 Agent 留在 TypeScript + Vercel AI SDK，前端仍是独立的
`web/`（Vite + Tailwind + shadcn/ui），用 concurrently 双进程开发。现在希望：

1. 用 Next.js App Router 统一前端与 HTTP 入口，去掉 Vite 子包；
2. UI 改用 Astryx（`@astryxdesign/core` + theme-neutral），从官方模板起步；
3. 继续钉住 Chatty 的 turn-based API 与 Evidence 信任边界。

## 决定

- **App**：仓库根 `app/` 为 Next.js App Router；`pnpm dev` → `next dev -p 3000`。
- **UI**：Astryx 组件 + `shell-side-nav` / `ai-chat` / `ai-chat-landing` / `library`
  模板骨架；中文文案；空态建议为商品推荐 / 政策问答，不是通用写作/编程 chips。
- **样式**：走 Astryx 官方 **Next.js + Tailwind** 路径（`fonts.css` + cascade `@layer` +
  `tailwind-theme.css` bridge），不自造 token 映射或第二套设计系统。
- **HTTP**：既有 Hono `createApp` 经 `hono/vercel` `handle` 挂到
  `app/api/[[...route]]/route.ts` 与 `app/health/route.ts`；`runtime = 'nodejs'`，
  因为 Catalog 用 `node:sqlite`。确定性测试仍直接打 `createApp`，不经 Next。
- **Agent / Data**：`src/agent`、`src/data`、`src/server` 逻辑保留；会话仍是内存单例。
- **删除**：根下 `web/` Vite 应用与 `copy-web-dist` / concurrently 双进程编排。
- **CI**：仍是 `pnpm check` = typecheck + 确定性测试 + `next build`。

## 取舍

- **不**用 DefaultChatTransport / 自由文本流作为主信任边界：推荐卡片、澄清与价格库存
  必须经 finalize + SQLite 重查；UI 复用 AI SDK `ChatStatus` 心智，协议仍是 turn JSON。
- **不**引入 Multi-Agent、Handoff、LangChain、LangGraph 或 eve。
- 可选 `pnpm dev:api` 仍可单独起 Hono（调试用）；演示主路径是 Next 同进程挂载 API。

## 影响

- ADR 0006 中「前端保留 `web/` Vite」部分被本 ADR 取代；AI SDK Agent 与 Evidence 边界不变。
- 文档入口仍是根 `CONTEXT.md` 与 `AGENTS.md`（含 Astryx 追加块）。
