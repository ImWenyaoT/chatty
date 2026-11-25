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

单仓 TypeScript：Next.js App Router + Astryx UI + Hono（经 route handler 挂载）+ Vercel AI SDK Agent。布局理由见 ADR 0007：

```bash
pnpm setup          # 或 make setup
pnpm dev            # Next :3000（UI + /api + /health）
pnpm dev:api        # 仅 Hono HTTP（调试用）
pnpm check          # typecheck + 确定性测试 + next build
```

目录：

- `src/agent/` — Chatty 的 `Model + Harness`（AI SDK `generateText` / Tool / Evidence）。
- `src/data/` — SQLite Catalog；种子在 `data/seed/`。
- `src/server/` — Hono HTTP 与内存会话；由 `app/api` / `app/health` 挂载。
- `app/` — Next.js App Router；Astryx 主题与页面。
- `components/` / `lib/` — Chatty UI 与 turn API 客户端。
- `scripts/smoke-browser.ts` — 可选 `agent-browser` 冒烟（不进 CI）。
- `docs/` — ADR 与说明。

依赖方向：UI 经 HTTP 调 `/api`；`src/server` 委托给 `agent` 与 `catalog`，自身不含业务规则。

## Testing

`pnpm check`（或 `make check`）`MUST` 是唯一 CI 门禁。`.github/workflows/ci.yml` 只运行这一条路径。

```bash
pnpm check
```

- `pnpm test` — 确定性单元 / HTTP / golden 测试（含 Scripted Model）。
- `pnpm build` — Next.js production build。
- `pnpm smoke:browser` — 可选；需本地 `pnpm dev` 与浏览器。

Agent 真实模型评测不再作为 CI 门禁；本地需 `DEEPSEEK_API_KEY` 后手动起服务验证对话。

改动代码时 `SHOULD` 补充测试或更新已有测试。

## PR instructions

- commit 标题 `MUST` 使用 conventional commits 英文前缀和中文标题。例：
  `refactor: 迁到 Next.js App Router 与 Astryx UI`
- 前缀 `MUST` 是 `feat` / `fix` / `refactor` / `docs` / `chore` / `test` 之一。
- 提交前 `MUST` 运行 `pnpm check`（或 `make check`）。

## Agent skills

### Issue tracker

Issues/PRD 存于本仓库 GitHub Issues，用 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用默认五标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文：根 `CONTEXT.md` 是唯一的领域词汇入口。See `docs/agents/domain.md`.

<!-- ASTRYX:START -->
Astryx v0.7.17 · 174 components
CLI: run every command as `pnpm exec astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx component <Name>` to read props before using one; `astryx template <Block>` prints a block example to read for a part it lacks. Astryx names differ from other libraries: buttons, badges, tokens and tabs take their text in `label` (Text, Heading and Link take children), booleans start with `is` or `has` (`isOpen`, `isDisabled`), and every input takes `value` and `onChange`.
Changing an existing page? Keep it: skip step 2 and add components inside its sections; read a block example when it helps.
Before you deliver a build, run `astryx doctor --built <dir>`; don't deliver it if it fails.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then tokens (var(--color-*|--spacing-*|--radius-*)). No raw hex/px. No StyleX/Tailwind compiler here — don't use xstyle/utility classes directly. Some templates use StyleX and need a compiler plugin; see `astryx docs styling-overview`.
- THEMES: palettes and custom colors go through the theme, never :root overrides; so does a denser or roomier app (`editor set <name> spacing tight`), never gap and padding changes page by page. A change to one kind of part (the sidebar, its selected item, the gaps in a form) is a theme change too, not props on one page: `editor how "<ask>"` names the `set … --on <part>` line. No app yet: `astryx experimental theme preview app <dir>` makes a starter app that shows the theme. To make or change a theme (colors, fonts, corners, spacing, a look from a picture), prefer the experimental theme editor over hand-written theme files: `astryx experimental theme editor new <name> --like neutral`, then `editor set <name> <thing> <value>` or `editor how "<what you want>"`; wire it with `astryx theme add <name>`; after each change look at it with `astryx experimental theme editor show <name> --png` (takes pictures of real components) and open the PNGs it writes; a theme change is not done until you have looked at the pictures. In code, extend an imported theme to customize it; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any raw <div>/<span>, imported .css/@apply, or hardcoded #hex/px with the component or a token.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands and API reference
  docs authoring     build an integration package, and every field it holds
  upgrade --from <old version> --apply   run after a dependency bump
To remove this block, run `astryx init --remove-agents`, which removes it from the agent files at the project root and in the folder you run it in; from any other file it leaves, delete everything from ASTRYX:START to ASTRYX:END.
<!-- ASTRYX:END -->
