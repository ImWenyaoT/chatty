# Chatty

Chatty is a Next.js-first customer-service harness for rental commerce.

The repository is a single, typed TypeScript customer-service harness for:

- customer-service task scheduling and loop control;
- context assembly and prompt input shaping;
- structured model-output parsing;
- policy-aware action execution;
- agentic knowledge search (SQLite FTS5 + `search_knowledge` tool + bounded loop);
- SQLite-backed session and trace state;
- a default DeepSeek pro compose path through Agents SDK, with deterministic fallback when unavailable;
- a plain golden regression check under `eval/`;
- documentation-first architecture decisions under `docs/`.

## 如果你只有 10 分钟

这个仓库是单一的客服场景 harness：`/api/playground` 走
[`packages/agent-core/src/customer-harness.ts`](packages/agent-core/src/customer-harness.ts)，
负责 task scheduling、context 拼接、output parser、executor 和 trace；质量回归由根级
`eval/` 的朴素金标承担。按信号密度排序的五个入口：

1. **客服 Harness Core** — [`packages/agent-core/src/customer-harness.ts`](packages/agent-core/src/customer-harness.ts) +
   [`packages/agent-core/src/customer-harness.test.ts`](packages/agent-core/src/customer-harness.test.ts)：确定性任务调度、
   context fragments、JSON output parser、policy-aware executor、trace/memory patch 的第一条可运行闭环。
2. **Playground 主链路** — [`apps/web/app/api/playground/route.ts`](apps/web/app/api/playground/route.ts)
   把用户输入接入 harness，持久化 `harnessTrace`，并在 UI 展示 task/action/tool/context 观测信息。
   配置 `OPENAI_API_KEY` 后 compose 步默认走 DeepSeek pro + Agents SDK；
   没有 key 或模型调用失败时回退确定性 composer。
3. **Eval 金标回归** — [`eval/run.ts`](eval/run.ts) + [`eval/golden/`](eval/golden) +
   [`eval/judge.ts`](eval/judge.ts)：进程内直调 harness 步跑 14 个金标场景，runner 同步调
   LLM-judge 回填每场景分数。LLM-judge 的 ±2 分噪声用 `--repeat` 聚合抵消，`--save` 落基线、
   `--baseline` 输出逐场景 Δ（promptVersion 用 compose 指令内容哈希可溯源）。`pnpm eval` 一条命令。
4. **策略化工具安全门** — [`packages/agent-core/src/tools/registry.ts`](packages/agent-core/src/tools/registry.ts)
   的 `invokeWithPolicy` 在执行前先过 [`packages/agent-core/src/policies/policy.ts`](packages/agent-core/src/policies/policy.ts)
   的 allow / require_approval / deny 决策：高风险工具（如 `issue_refund`）永不自动执行，
   `ApprovalRequiredError` / `PolicyDenyError` 被 harness executor 捕获后转人工。
   "closed 会话拒绝一切新副作用"等不变量有测试锁定。
5. **客服知识检索（agentic search）** — compose 步内的有界工具循环：模型自主决定
   是否调 [`packages/agent-core/src/tools/search-knowledge.ts`](packages/agent-core/src/tools/search-knowledge.ts)
   的 `search_knowledge`（SQLite FTS5 trigram + 中文 2 字词 LIKE 回退，服务端固定 top-3），
   命中知识库后把结果作为 `knowledge` context fragment 落回，最多 3 次搜索到顶强制作答；
   任何失败回退确定性 composer（"无 key 可跑"是不变量）。索引由
   [`packages/db/src/knowledge-index.ts`](packages/db/src/knowledge-index.ts) 启动时幂等同步
   `knowledge/` 语料。当前架构入口见 [Harness Design Map](docs/design.md)；
   历史检索规格见 [agentic-search-design.md](docs/archive/agentic-search-design.md)。
   早先基于 embedding/qdrant 的检索子系统已退役（2026-07）。

## Current Status

This is a working customer-service harness MVP: `/api/playground` runs task scheduling → context assembly → model-output composition (DeepSeek pro + Agents SDK by default when a key is present, deterministic fallback when unavailable) → parsing → action execution → trace persistence, and the UI shows the resulting harness trace. Knowledge retrieval is an agentic search step (SQLite FTS5 + `search_knowledge` tool + bounded loop). Quality is guarded by a plain golden regression check under `eval/` (`pnpm eval`). The legacy `rag-service` lane has been fully retired; the migration history is recorded in the [Legacy Migration Ledger](docs/archive/loop-engineering-plan.md#16-legacy-migration-ledger).

## Useful Commands

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test                 # workspace 单测
pnpm smoke                # 无 LLM 的核心数据链路冒烟（SQLite + session/trace + memory 连续性）
pnpm typecheck:skeleton
pnpm eval                 # 朴素金标回归（harness lane，需真实 LLM）
```

## Quality Gates

Chatty follows one testing rule: in agentic coding, every behavior that can be
automatically verified should be automatically verified.

- `pnpm test` runs workspace unit tests and lightweight integration tests.
- `pnpm smoke` runs the no-network core data path through SQLite session/trace/memory.
- `pnpm typecheck` verifies TypeScript contracts across workspaces and eval.
- `pnpm lint` keeps formatting and static checks stable through Biome.
- `.github/workflows/ci.yml` runs skeleton build, lint, smoke, tests, typecheck,
  and build on PRs and `main`.
- `.github/workflows/eval.yml` is the manual real-LLM golden regression gate for
  prompt, model, and judge behavior.

The required command and CI-step contract is executable documentation in
[`packages/shared/src/quality-gates.ts`](packages/shared/src/quality-gates.ts)
and is locked by
[`packages/shared/src/quality-gates.test.ts`](packages/shared/src/quality-gates.test.ts).

## Docs

- Agent architecture design: [Harness Design Map（设计选择 + 代码结构 + 架构图主文档）](docs/design.md)
- Extra diagrams: [Current Architecture（agent-first 补充图集）](docs/current-architecture.md)
- Decisions and rejected options: [Tech Stack Decisions（唯一决策登记处）](docs/tech-stack-decisions.md)
- History only: [Architecture (RW-1 历史目标架构，不是当前实现入口)](docs/archive/architecture.md)
