---
status: accepted
supersedes: 0005-go-backend-vite-shadcn
---

# 后端回到 TypeScript，Agent 改用 Vercel AI SDK

## 背景

ADR 0005 把后端迁到 Go 自研 Tool Loop，前端留在 Vite + shadcn/ui。现在希望整仓回到
TypeScript，并用社区主流的 Vercel AI SDK（含 AI SDK UI 心智）与 agent-browser 冒烟工具，
降低维护两套语言运行时的成本，同时保留 Chatty 的 Harness / Evidence 边界。

## 决定

- **Backend**：Hono + Node 直跑 TypeScript；Catalog 仍用 `node:sqlite` + FTS5；种子在
  `data/seed/`。
- **Agent**：用 Vercel AI SDK（`ai` + `@ai-sdk/openai`）的 `generateText` /
  `Output.object` / `tool` / `prepareStep` 实现主 Loop 与两个 Harness Subagent
  （`request_parser`、`draft_corrector`）。**不**引入 Multi-Agent、Handoff、LangChain、
  LangGraph 或 eve 式「Subagent 降级成 Tool」。
- **Frontend**：保留 `web/`（Vite + React + Tailwind + shadcn/ui）。引入
  `@ai-sdk/react` / `ai` 的 `ChatStatus` 心智，经 `useChattySession` 封装；HTTP 仍走
  既有 turn API，因为 Evidence 校验要求整轮草稿完整后才能出推荐卡片。
- **冒烟**：`agent-browser` 作为可选本地脚本（`pnpm smoke:browser`），不进默认 CI。
- **CI 门禁**：`pnpm check`（typecheck + 确定性测试 + 前端 build）。

## 取舍

- **不用 eve**：CONTEXT 已写明 Chatty Subagent 仅由 Harness 触发，与 eve「parent 可见
  Tool」语义分歧；继续钉住 Single Agent 判据（`handoffs: []`，主 `tools` 不含 Subagent）。
- **不用 DefaultChatTransport / 自由文本流作为主路径**：推荐卡片、澄清与价格库存必须经
  finalize + SQLite 重查；流式自由文本会绕过这条信任边界。UI 复用 AI SDK 的 status
  语义，协议仍是 turn-based JSON。
- **删除 Go `backend/`**：Harness 逻辑回到 `src/agent/`；旧 ADR 0005 在运行时上被本 ADR
  取代，领域约束（会话内存、SQLite 只存演示数据、价格库存不由 Model 生成）不变。

## 影响

- 根目录恢复 `package.json` / pnpm workspace（`.` + `web`）。
- `Makefile` 包装 `pnpm` 脚本；`.github/workflows/ci.yml` 不再安装 Go。
- 文档入口仍是根 `CONTEXT.md` 与 `AGENTS.md`。
