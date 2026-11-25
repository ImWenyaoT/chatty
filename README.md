<div align="center">

# Chatty

面向电商推荐与政策问答的中文 Single Agent。

<sub>Model 负责理解需求、主动检索与生成表达；Harness + SQLite 负责流程、事实与可信输出。</sub>

[![CI](https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml/badge.svg)](https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-AI%20SDK-3178C6?logo=typescript&logoColor=white)](package.json)
[![Next.js](https://img.shields.io/badge/Next.js-Astryx-000000?logo=nextdotjs&logoColor=white)](package.json)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

Chatty 不是“让模型直接推荐商品”的聊天壳。它把一次请求拆成结构化需求、确定性业务准备、
Model 主导的 Tool Loop、Evidence 校验与领域输出：商品 ID、价格和库存必须来自 SQLite，
知识问答必须经过检索，模型只负责语义理解、检索决策和自然语言表达。

> 给 Model 自由度，但不把业务事实也交给 Model。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js App Router + Astryx（`@astryxdesign/core`）+ AI SDK UI 心智 |
| HTTP | Hono（经 Next route handler 挂载，`runtime = nodejs`） |
| Catalog | SQLite FTS5（`node:sqlite`） |
| Agent | Vercel AI SDK（`generateText` / Tool / structured output） |
| Model | DeepSeek（OpenAI 兼容 Chat Completions） |
| 冒烟 | agent-browser（可选，本地） |

## 快速开始

前置：Node 22+、pnpm 11+。

```bash
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
pnpm setup             # 或 make setup

# Next.js :3000（UI + /api + /health）
pnpm dev               # 或 make dev
```

检查：

```bash
pnpm check             # typecheck + 测试 + next build
```

可选 UI 冒烟（需先 `pnpm dev`）：

```bash
pnpm smoke:browser
```

## 一次请求如何完成

1. **Request Parser（Subagent）** 把用户原话解析成 `ParsedRequest`（商品需求 / 知识问题）。
2. **Harness** 从 SQLite 确定性准备画像、候选商品与库存，写入 Evidence。
3. **主 Agent Loop（AI SDK）** 调用 `retrieve_knowledge` / `get_marketing_strategy`，按门禁推进。
4. **Evidence 校验 + SQLite 重查** 后才返回推荐/澄清/回答；价格与库存不由模型生成。

## 仓库布局

```
app/         Next.js App Router + Astryx 页面与 API 挂载
components/  Chatty UI（对话、目录、壳）
lib/         turn API 客户端与会话 Hook
src/agent/   AI SDK Agent + Harness + tools + subagents
src/data/    SQLite Catalog
src/server/  Hono createApp + 内存会话
data/seed/   SQLite 初始化种子（非运行时查询接口）
docs/adr/    架构决策（现行见 0007）
```

领域词汇见 [`CONTEXT.md`](CONTEXT.md)。工程约定见 [`AGENTS.md`](AGENTS.md)。

## 与双进程 Vite 栈的差异

- 前端从 `web/` Vite + shadcn 迁到根 `app/` Next.js + Astryx。
- Hono 仍提供契约；Next catch-all 转发 `/api/*` 与 `/health`。
- 会话 Hook 对齐 AI SDK `ChatStatus`，协议仍是 turn-based（保护 Evidence）。
- CI 只跑 `pnpm check`。详见 [ADR 0007](docs/adr/0007-nextjs-astryx.md)。
