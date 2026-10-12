## Domain docs

工程工作开始前先读取根 `CONTEXT.md`。它是当前唯一的领域词汇入口。

## Requirement keywords

本文中的 `MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT` 和 `MAY` 按
[BCP 14](https://www.rfc-editor.org/info/bcp14/) 解释。只有全大写形式具有规范含义。

- `MUST` 和 `MUST NOT` 表示无例外的要求或禁止事项
- `SHOULD` 和 `SHOULD NOT` 表示默认规则；偏离时必须说明理由和影响
- `MAY` 表示可选做法

只对影响正确性、安全性、互操作性或工程门禁的规则使用这些关键词。可由代码约束的 `MUST`
优先通过类型、schema、Harness 校验或测试实施，不能只依赖 Model instructions。

## Vocabulary

- Chatty 是一个 Single Agent。
- 用户画像、商品搜索、库存检查、知识检索和营销策略都是 Tool / Harness 步骤，不是 Agent。
- RAG 指 `retrieve_knowledge` 执行检索、结果进入 Agent 上下文并参与生成的完整流程。
- SQLite 保存演示业务数据；SQLite FTS5 保存并检索知识文档。
- 技术名称和代码标识保留英文，其余说明优先使用简体中文。

## Project boundaries

- 项目 `MUST NOT` 引入 Multi-Agent、Handoff、LangChain 或 LangGraph。
- 项目 `MUST NOT` 增加外部数据库或向量数据库。前端与 HTTP 层是例外，见 ADR 0001。
- 会话状态 `MUST` 存在服务端内存，`MUST NOT` 写入 SQLite。SQLite 只保存演示业务数据与知识检索数据。
- 商品价格和库存 `MUST` 来自 SQLite，`MUST NOT` 由 Model 生成。
- JSON/JSONL `MUST` 只作为 SQLite 初始化种子，`MUST NOT` 作为运行时业务查询接口。

## Dev environment

单仓双运行时：Go 后端 + Vite 前端。布局理由见 ADR 0005：

```bash
make setup          # go mod download + web pnpm install
make dev            # API :8000 + Vite :5173（代理 /api）
make api-dev        # 仅 Go HTTP
make web-dev        # 仅 Vite
make check          # go test + 前端 typecheck/build
```

根目录没有 `package.json`；前端依赖只在 `web/`。

目录：

- `backend/` — Go：`cmd/chatty` 入口，`internal/api` HTTP，`internal/agent` Model+Harness，
  `internal/catalog` SQLite，`prompts/` 提示词。
- `web/` — React + Vite + Tailwind + shadcn/ui + TypeScript；只经 `src/lib/api-client.ts` 打 HTTP。
- `data/seed/` — SQLite 初始化种子。
- `docs/` — ADR 与说明。

依赖方向：`web/` 不 import `backend/`；`internal/api` 委托给 `agent` 与 `catalog`，自身不含业务规则。

## Testing

`make check` `MUST` 是唯一 CI 门禁。`.github/workflows/ci.yml` 只运行这一条路径。

```bash
make check
```

- `make backend-test` — Go 单元/HTTP 契约测试。
- `make web-check` — 前端 typecheck + production build。

Agent 真实模型评测不再作为 CI 门禁；本地需 `DEEPSEEK_API_KEY` 后手动起服务验证对话。

改动代码时 `SHOULD` 补充测试或更新已有测试。

## PR instructions

- commit 标题 `MUST` 使用 conventional commits 英文前缀和中文标题。例：
  `refactor: 将后端迁到 Go 并重建 Vite/shadcn 前端`
- 前缀 `MUST` 是 `feat` / `fix` / `refactor` / `docs` / `chore` / `test` 之一。
- 提交前 `MUST` 运行 `make check`。

## Agent skills

### Issue tracker

Issues/PRD 存于本仓库 GitHub Issues，用 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用默认五标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文：根 `CONTEXT.md` 是唯一的领域词汇入口。See `docs/agents/domain.md`.
