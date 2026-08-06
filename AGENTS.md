## Domain docs

工程工作开始前先读取根 `CONTEXT.md`。它是当前唯一的领域词汇入口。

## Vocabulary

- Chatty 是一个 Single Agent。
- 用户画像、商品搜索、库存检查、知识检索和营销策略都是 Tool，不是 Agent。
- RAG 指 `retrieve_knowledge` 执行检索、结果进入 Agent 上下文并参与生成的完整流程。
- SQLite 保存演示业务数据；SQLite FTS5 保存并检索知识文档。
- 技术名称和代码标识保留英文，其余说明优先使用简体中文。

## Project boundaries

- 不引入 Multi-Agent、Handoff、LangChain 或 LangGraph。
- 不增加外部数据库或向量数据库。前端与 HTTP 层是例外，见 ADR 0001。
- 会话状态存服务端内存，不进 SQLite——SQLite 只管演示业务数据与知识检索。
- 商品价格和库存必须来自 SQLite，不能由模型生成。
- JSON/JSONL 是 SQLite 的初始化种子，不是运行时业务查询接口。

## Dev environment

单包仓库，只有一份根 `package.json`。装依赖：

```bash
pnpm install
```

顶层六个目录按领域切分，布局理由见 ADR 0004：

- `agent/` — Agent 表面：`agent.ts` + `instructions.md` + `tools/` + `hooks/` + `subagents/` + `lib/`。路径决定身份，文件名即 Tool 名、Hook 名；共享代码只放 `lib/`。
- `data/` — SQLite 访问层与种子数据。
- `server/` — HTTP 层与进程入口。
- `web/` — Vite + React 前端。
- `evals/` — 行为评测与检索评测，`<name>.eval.ts` 一文件一个 Eval，`evals.config.ts` 与 `lib/` 不是 Eval。
- `tests/` — 单元测试。

Node 24 直跑 `.ts`，靠 Node 原生类型剥离，服务端没有构建步骤也没有 dist。因此 `tsconfig.server.json` 开着
`erasableSyntaxOnly`：只写擦除类型后即为合法 JS 的语法。enum、参数属性、`namespace` 需要转译，
写了就通不过 `pnpm typecheck`。

## Testing

`pnpm run check` 是唯一门禁，等价于 CI——`.github/workflows/ci.yml` 只跑这一条。本地绿即 CI 绿。

```bash
pnpm run check
```

评测 lane：

- `pnpm test` — `tests/` 下的 `node:test` 单元测试，已包含在 `check` 里。
- `pnpm eval` — `evals/lib/runner.ts` 跑 `evals/` 下全部 Eval，退出码 0 表示每个跑过的 Eval 都过了自己的 gate。
- `pnpm eval:retrieval` — 同一个 runner 只跑 `retrieval.eval.ts`。改检索、切块、Query 改写或知识种子后跑。
- `pnpm eval:agent` — 同一个 runner 只跑 `agent.eval.ts`，调真实模型，需要 API key；缺 key 按 `evals.config.ts` 的 `onMissingCredentials` 处理，当前判失败。

改 Agent 行为或 prompt 时必须跑 `pnpm eval:agent`，把改动前后的结果逐条比对，并在 PR 描述里
写明差异。只搬文件、改 import、改类型而不改逻辑时，跑 `pnpm run check` 就够。

改动代码就补测试或更新已有测试，即使 issue 没有要求。移动文件或改 import 之后跑 `pnpm lint`。

## PR instructions

- commit 标题格式：conventional commits 英文前缀 + 中文标题。例：
  `refactor: 扁平化仓库布局，agent/ 提升为顶层目录`
- 前缀取 `feat` / `fix` / `refactor` / `docs` / `chore` / `test` 之一。
- 提交前跑 `pnpm run check`。

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
