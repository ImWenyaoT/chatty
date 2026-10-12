---
status: accepted
---

# 后端迁到 Go，前端迁到 Vite + Tailwind + shadcn/ui

## 背景

Chatty 原先是 Node/TypeScript 全栈：Hono HTTP、OpenAI Agents SDK、Vite React。目标改为
「Go 后端 + React/Vite/Tailwind/shadcn/TS 前端」单仓，便于用 Go 表达 Harness 确定性逻辑，
并用现代组件体系重做演示界面。

## 决定

- `backend/`：Go HTTP API、Agent 编排（Request Parser / Tool Loop / Evidence）、SQLite FTS5。
- `web/`：Vite + React + TypeScript + Tailwind CSS + shadcn/ui（手写常用 UI 原语）。
- `data/seed/`：演示业务与知识种子，仍只在 SQLite 初始化时读取。
- 会话状态仍在服务端内存；不引入外部/向量数据库、Multi-Agent、Handoff、LangChain/LangGraph。

## 取舍

- **不再使用 OpenAI Agents SDK**。Go 侧用 DeepSeek/OpenAI 兼容 Chat Completions + Tool Calling
  自实现 Agent Loop 与门禁；领域约束（Evidence、库存/价格重查）保持。
- **旧 `src/evals/` 与 Node `pnpm eval*` 不再迁移**。主线是可运行全栈与 HTTP/Catalog 测试；
  Agent 行为评测可后续用 Go 或外部脚本补回。
- **CI 门禁**改为 `make check`（`go test ./...` + 前端 typecheck/build），不再依赖根 `pnpm run check`。

## 影响

- ADR 0003（TypeScript 迁移）与 ADR 0004（扁平 `src/`）在路径与运行时上被本 ADR 取代；
  ADR 0001 的前后端分层与「会话内存 / SQLite 只存演示数据」仍然有效。
- 根目录不再有 `package.json`；工程入口是 `Makefile`，前端依赖仅在 `web/package.json`。
- 过时的 `docs/chatty-book/`（仍写旧 `src/` 路径与 `pnpm eval*`）已删除；领域入口为根 `CONTEXT.md`。
