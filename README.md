# Chatty

Chatty is a Next.js-first agentic customer-service prototype for rental commerce.

The current repository keeps the existing `rag-service` runnable while adding a gradual TypeScript/Node.js foundation for:

- bounded agent-loop orchestration;
- SQLite-backed session and trace state;
- conservative migration of existing customer/product memory;
- OpenAI Agents SDK TypeScript adapters;
- OpenAI Chat Completions compatibility and fallback adapters;
- documentation-first architecture decisions under `docs/`.

## 如果你只有 10 分钟

这个仓库有两条 lane（先建的确定性 RAG 管线 `rag-service`，和在它之上用 feature flag +
adapter 边界保守迁移出的 agent loop 新线 `packages/*` + `apps/web`，见
[Loop Engineering Plan](docs/loop-engineering-plan.md)）。按信号密度排序的五个入口：

1. **Eval 迭代证据链** — [`rag-service/scripts/eval.ts`](rag-service/scripts/eval.ts) +
   [`rag-service/tests/golden/`](rag-service/tests/golden) +
   [`rag-service/tests/reports/`](rag-service/tests/reports)：多轮金标回归、LLM-judge 的
   ±2 分噪声用 `--repeat` 聚合抵消、`--baseline` 输出逐场景 Δ。reports 里 base0→iter4
   记录了回复质量 6/11 → 11/11 的完整迭代轨迹（promptVersion 内容哈希可溯源）。
2. **双层工具安全门** — [`packages/agent-core/src/loop-runner.ts`](packages/agent-core/src/loop-runner.ts)
   按风险策略过滤暴露给 SDK 的工具；[`packages/llm/src/agents-sdk-adapter.ts`](packages/llm/src/agents-sdk-adapter.ts)
   的 `sdkToolExecute` 在边界上二次拒绝一切非低风险/需审批工具。"closed 会话零工具暴露"
   等不变量有测试锁定。
3. **评测数据飞轮（可演示的闭环）** — trace → LLM-judge review → failure_case →
   [`scripts/promote-failure-case.mts`](scripts/promote-failure-case.mts) 晋升为
   `tests/golden/regression-*.yaml` → `pnpm eval` 回归。CI 的 smoke 阶段
   （[`scripts/smoke.mts`](scripts/smoke.mts)）每次提交都把这个飞轮真转一圈。
4. **防上下文污染的记忆门控** — [`rag-service/src/rag/intent-classifier.ts`](rag-service/src/rag/intent-classifier.ts)
   的 `intentToExtractionPolicy`：按本轮意图门控允许写入哪些 profile 字段，修掉
   "要图片却改写商品意向"这类真实的 loop 退化。
5. **确定性优先、LLM 受限的动作路由** — [`rag-service/src/rag/action-picker.ts`](rag-service/src/rag/action-picker.ts)
   13 条 fast-path 规则优先命中，LLM 只在强制 `tool_choice` 下做四选一兜底；
   [`rag-service/src/rag/action-specs.ts`](rag-service/src/rag/action-specs.ts) 的三层输出
   安全门（per-action 硬规则 → 全局禁词正则 → 确定性模板回退），回退率经
   `answerSource` 可观测。

## Current Status

This is a working MVP: the bounded loop runs end to end behind `/api/playground` (classify → route → reply/handoff, trace + async eval persisted), with the legacy `rag-service` as the answer lane behind an in-process adapter. Migration progress is tracked in the [Legacy Migration Ledger](docs/loop-engineering-plan.md#16-legacy-migration-ledger).

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
