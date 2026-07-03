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
- OpenAI Agents SDK TypeScript adapters;
- OpenAI Chat Completions compatibility and fallback adapters;
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
3. **Eval 迭代证据链** — [`rag-service/scripts/eval.ts`](rag-service/scripts/eval.ts) +
   [`rag-service/tests/golden/`](rag-service/tests/golden) +
   [`rag-service/tests/reports/`](rag-service/tests/reports)：多轮金标回归、LLM-judge 的
   ±2 分噪声用 `--repeat` 聚合抵消、`--baseline` 输出逐场景 Δ。reports 里 base0→iter4
   记录了回复质量 6/11 → 11/11 的完整迭代轨迹（promptVersion 内容哈希可溯源）。
4. **双层工具安全门** — [`packages/agent-core/src/loop-runner.ts`](packages/agent-core/src/loop-runner.ts)
   按风险策略过滤暴露给 SDK 的工具；[`packages/llm/src/agents-sdk-adapter.ts`](packages/llm/src/agents-sdk-adapter.ts)
   的 `sdkToolExecute` 在边界上二次拒绝一切非低风险/需审批工具。"closed 会话零工具暴露"
   等不变量有测试锁定。
5. **评测数据飞轮（可演示的闭环）** — trace → LLM-judge review → failure_case →
   [`scripts/promote-failure-case.mts`](scripts/promote-failure-case.mts) 晋升为
   `tests/golden/regression-*.yaml` → `pnpm eval` 回归。CI 的 smoke 阶段
   （[`scripts/smoke.mts`](scripts/smoke.mts)）每次提交都把这个飞轮真转一圈。

## Current Status

This is a working customer-service harness MVP: `/api/playground` runs task scheduling → context assembly → model-output parsing → action execution → trace persistence, and the UI shows the resulting harness trace. The legacy `rag-service` remains available for golden evaluation, regression promotion, and migration reference. Migration progress is tracked in the [Legacy Migration Ledger](docs/loop-engineering-plan.md#16-legacy-migration-ledger).

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
