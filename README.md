# Chatty

Chatty is a Next.js-first customer-service harness for rental commerce.

The current repository keeps the existing `rag-service` runnable as evaluation and
compatibility evidence while moving the live playground path onto a small,
typed TypeScript harness for:

- customer-service task scheduling and loop control;
- context assembly and prompt input shaping;
- structured model-output parsing;
- policy-aware action execution;
- SQLite-backed session and trace state;
- conservative migration of existing customer/product memory;
- an optional LLM compose path (OpenAI-compatible Chat Completions, `CHATTY_LLM=1`) with a deterministic fallback;
- documentation-first architecture decisions under `docs/`.

## 如果你只有 10 分钟

这个仓库现在主线是客服场景的 harness：`/api/playground` 走
[`packages/agent-core/src/customer-harness.ts`](packages/agent-core/src/customer-harness.ts)，
负责 task scheduling、context 拼接、output parser、executor 和 trace；`rag-service`
保留为金标评测、回归样本和兼容参考。按信号密度排序的五个入口：

1. **客服 Harness Core** — [`packages/agent-core/src/customer-harness.ts`](packages/agent-core/src/customer-harness.ts) +
   [`packages/agent-core/src/customer-harness.test.ts`](packages/agent-core/src/customer-harness.test.ts)：确定性任务调度、
   context fragments、JSON output parser、policy-aware executor、trace/memory patch 的第一条可运行闭环。
2. **Playground 主链路** — [`apps/web/app/api/playground/route.ts`](apps/web/app/api/playground/route.ts)
   把用户输入接入 harness，持久化 `harnessTrace`，并在 UI 展示 task/action/tool/context 观测信息。
   compose 步可选走真 LLM（`CHATTY_LLM=1` + `OPENAI_API_KEY`，Chat Completions adapter），
   未配置或模型调用失败时回退确定性 composer，demo 零配置可跑。
3. **Eval 迭代证据链** — [`rag-service/scripts/eval.ts`](rag-service/scripts/eval.ts) +
   [`rag-service/tests/golden/`](rag-service/tests/golden) +
   [`rag-service/tests/reports/`](rag-service/tests/reports)：多轮金标回归、LLM-judge 的
   ±2 分噪声用 `--repeat` 聚合抵消、`--baseline` 输出逐场景 Δ。reports 里 base0→iter4
   记录了回复质量 6/11 → 11/11 的完整迭代轨迹（promptVersion 内容哈希可溯源）。
4. **策略化工具安全门** — [`packages/agent-core/src/tools/registry.ts`](packages/agent-core/src/tools/registry.ts)
   的 `invokeWithPolicy` 在执行前先过 [`packages/agent-core/src/policies/policy.ts`](packages/agent-core/src/policies/policy.ts)
   的 allow / require_approval / deny 决策：高风险工具（如 `issue_refund`）永不自动执行，
   `ApprovalRequiredError` / `PolicyDenyError` 被 harness executor 捕获后转人工。
   "closed 会话拒绝一切新副作用"等不变量有测试锁定。
5. **评测数据飞轮（可演示的闭环）** — playground 每条 trace 落库后，
   [`apps/web/lib/eval-chain.ts`](apps/web/lib/eval-chain.ts) fire-and-forget 跑
   LLM-judge（复用 legacy evaluator；需 `CHATTY_SQLITE=1` + `OPENAI_API_KEY`，
   未配置时静默跳过）→ review 落 `trace_reviews`（`/dashboard` 实时读表）→ 低分晋升
   failure_case → [`scripts/promote-failure-case.mts`](scripts/promote-failure-case.mts)
   晋升为 `tests/golden/regression-*.yaml` → `pnpm eval` 回归。CI 的 smoke 阶段
   （[`scripts/smoke.mts`](scripts/smoke.mts)）用模拟评分把同一条数据链路每次提交真转一圈。

## Current Status

This is a working customer-service harness MVP: `/api/playground` runs task scheduling → context assembly → model-output composition (optional LLM via `CHATTY_LLM=1`, deterministic fallback) → parsing → action execution → trace persistence, and the UI shows the resulting harness trace. The legacy `rag-service` remains available for golden evaluation, regression promotion, and migration reference. Migration progress is tracked in the [Legacy Migration Ledger](docs/loop-engineering-plan.md#16-legacy-migration-ledger).

## Useful Commands

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test                 # workspace 单测（含 rag-service parsers）
pnpm smoke                # 无 LLM 的全数据链路冒烟（含飞轮晋升一圈）
pnpm typecheck:skeleton
pnpm build:rag-service
pnpm promote:failure-case # 失败用例 → 金标回归的晋升 CLI（--list 查看候选）
```

## Docs

- [Tech Stack Decisions](docs/tech-stack-decisions.md)
- [Loop Engineering Plan](docs/loop-engineering-plan.md)
- [Agentic Customer Service PRD](docs/agentic-customer-service-prd.md)
