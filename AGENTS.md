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
- 用户画像、商品搜索、库存检查、知识检索和营销策略都是 Tool，不是 Agent。
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

单包仓库，只有一份根 `package.json`。装依赖：

```bash
pnpm install
```

源码全部收进 `src/`，按「前端黑盒 ↔ API ↔ 后端」分层，配置文件全在根。布局理由见 ADR 0004：

- `src/agent/` — Agent 表面，即 `Model + Harness`：`agent.ts` + `instructions.md` + `tools/` + `subagents/` + `lib/`。`tools/` 一文件一个模型 Tool，由 `agent.ts` 静态 import；不使用目录扫描或 registry。
- `src/data/` — SQLite 访问层与种子数据。
- `src/server/` — 后端：`api.ts`（Hono 路由）+ `main.ts`（进程入口）+ `session-store.ts` + `settings.ts`。
- `src/web/` — React 前端：`App.tsx` + `main.tsx` + `globals.css` + `components/` + `api-client.ts` + `format.ts`。
- `src/evals/` — 行为评测与检索评测，`<name>.eval.ts` 一文件一个 Eval，`evals.config.ts` 与 `lib/` 不是 Eval。
- `tests/` — 单元测试。

`src/agent/lib/` 与 `src/evals/lib/` 是各自 slot 内部的共享代码，不是同一个 `lib/`。

依赖方向由分层固定：`src/web/` 只经 `api-client.ts` 打 HTTP，不 import `src/agent/` 与
`src/server/`；`src/server/api.ts` 是唯一的 API 边界，它委托给 `src/agent/` 与 `src/data/`，
自己不含业务规则。

Node 24 直跑 `.ts`，靠 Node 原生类型剥离。因此 `tsconfig.json` 开着
`erasableSyntaxOnly`：只写擦除类型后即为合法 JS 的语法。enum、参数属性、`namespace` 需要转译，
写了就通不过 `pnpm typecheck`。

## Testing

`pnpm run check` `MUST` 是唯一 CI 门禁。`.github/workflows/ci.yml` 只运行这一条命令。

```bash
pnpm run check
```

评测 lane：

- `pnpm test` — `tests/` 下的 `node:test` 单元测试，已包含在 `check` 里。
- `pnpm eval` — `src/evals/lib/runner.ts` 跑 `src/evals/` 下全部 Eval，退出码 0 表示每个跑过的 Eval 都过了自己的 gate。
- `pnpm eval:retrieval` — 同一个 runner 只跑 `retrieval.eval.ts`。改检索、切块、Query 改写或知识种子后跑。
- `pnpm eval:agent` — 同一个 runner 只跑 `agent.eval.ts`，调真实模型，需要 API key；缺 key 按 `evals.config.ts` 的 `onMissingCredentials` 处理，当前判失败。

改 Agent 行为或 prompt 时 `MUST` 运行 `pnpm eval:agent`，逐条比较改动前后的结果，并在 PR
描述中写明差异。只搬文件、改 import、改类型而不改逻辑时，运行 `pnpm run check` 即可。

改动代码时 `SHOULD` 补充测试或更新已有测试，即使 issue 没有要求。移动文件或改 import 后
`MUST` 运行 `pnpm lint`。

## PR instructions

- commit 标题 `MUST` 使用 conventional commits 英文前缀和中文标题。例：
  `refactor: 收敛 Agent 装配与前端渲染抽象`
- 前缀 `MUST` 是 `feat` / `fix` / `refactor` / `docs` / `chore` / `test` 之一。
- 提交前 `MUST` 运行 `pnpm run check`。

为什么定这一套：最近 15 条 commit 混用了四套惯例——英文 conventional 前缀、`[chatty] Title`、
中文「重构：」「迁移：」、以及裸标题。conventional 前缀与 `[chatty]` 各 5 条并列最多，而
`[chatty]` 在单项目仓库里不携带信息；conventional commits 也与 `docs/adr/` 的工程习惯一致，
所以收敛到它。

## Agent skills

### Issue tracker

Issues/PRD 存于本仓库 GitHub Issues，用 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用默认五标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文：根 `CONTEXT.md` 是唯一的领域词汇入口。See `docs/agents/domain.md`.
