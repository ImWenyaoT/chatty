<div align="center">

# Chatty

面向电商推荐与政策问答的中文 Single Agent。

<sub>Model 负责理解需求、主动检索与生成表达；Harness + SQLite 负责流程、事实与可信输出。</sub>

[![CI](https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml/badge.svg)](https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/Go-1.22+-00ADD8?logo=go&logoColor=white)](backend/go.mod)
[![React](https://img.shields.io/badge/React-Vite%20%2B%20Tailwind%20%2B%20shadcn-61DAFB?logo=react&logoColor=black)](web/package.json)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

Chatty 不是“让模型直接推荐商品”的聊天壳。它把一次请求拆成结构化需求、确定性业务准备、
Model 主导的 Tool Loop、Evidence 校验与领域输出：商品 ID、价格和库存必须来自 SQLite，
知识问答必须经过检索，模型只负责语义理解、检索决策和自然语言表达。

> 给 Model 自由度，但不把业务事实也交给 Model。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React + Vite + TypeScript + Tailwind CSS + shadcn/ui |
| 后端 | Go（`net/http`）+ SQLite FTS5（`modernc.org/sqlite`） |
| Model | DeepSeek（OpenAI 兼容 Chat Completions + Tool Calling） |

## 快速开始

前置：Go 1.22+、Node 22+、pnpm 11+。

```bash
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
make setup

# 一条命令同时起 API (:8000) 与 Vite (:5173)
make dev

# 或分两个终端：
# make api-dev
# make web-dev
```

检查：

```bash
make check             # go test + 前端 typecheck/build
```

## 一次请求如何完成

1. **Request Parser（Subagent）** 把用户原话解析成 `ParsedRequest`（商品需求 / 知识问题）。
2. **Harness** 从 SQLite 确定性准备画像、候选商品与库存，写入 Evidence。
3. **主 Agent Loop** 调用 `retrieve_knowledge` / `get_marketing_strategy`，按门禁推进。
4. **Evidence 校验 + SQLite 重查** 后才返回推荐/澄清/回答；价格与库存不由模型生成。

## 仓库布局

```
backend/     Go API + Agent + Catalog + prompts/
web/         Vite + React + Tailwind + shadcn/ui
data/seed/   SQLite 初始化种子（非运行时查询接口）
docs/adr/    架构决策（现行见 0005）
Makefile     install / dev / check 入口
```

领域词汇见 [`CONTEXT.md`](CONTEXT.md)。工程约定见 [`AGENTS.md`](AGENTS.md)。

## 与旧 Node 栈的差异

- 后端从 TypeScript/Hono/OpenAI Agents SDK 迁到 Go 自研 Tool Loop。
- 前端在 `web/`，Tailwind + shadcn/ui；根目录无 `package.json`。
- 旧 `pnpm eval*`、golden 对拍与过时 chatty-book 路径文档已去掉；CI 只跑 `make check`。
  详见 [ADR 0005](docs/adr/0005-go-backend-vite-shadcn.md)。
