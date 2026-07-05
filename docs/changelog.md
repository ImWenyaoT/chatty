# Chatty Changelog

本文件记录和新版 JD 对齐的架构、测试、可观测性改动。发布级变更仍以 git commit 为准。

## 2026-07-05

### New JD architecture review

- 变更：按新版 `docs/jd.md` 增加 JD 能力覆盖矩阵，把 LLM API、KV Cache、Agent Loop、Tool Use、Reasoning、Planning、Skills、MCP、Memory、Subagent、Multi-Agent、Prompt / Context / Harness Engineering、评测、真实任务反馈和 UI/UX demo 逐项映射到当前代码状态。
- 设计选择：所有当前架构参考重新收敛到 OpenClaw / Codex / Claude Code 三选一；LLM billing/cache 改选 Codex，参考其 cached input token、turn usage 和 budget 思路，不再保留其它参考源例外。
- JD 对齐：明确当前最大差距是“真实任务反馈与产品指标”仍停留在 trace/session 可回放和 demo dashboard，下一步应做最小 trace review / feedback schema，而不是扩张 agent runtime。
- 自动验证：`packages/shared/src/architecture-bounds.test.ts` 锁住新版 JD 能力项每项只有一个主参考，并重新禁止当前架构文档引用区间外参考源。

### Cache-aware LLM telemetry

- 变更：playground 的 `harnessTrace.llm` 增加 `inputCacheHitRatio`，开发调试面板直接展示 prompt/KV cache 命中率。
- 设计选择：单选 Codex 的 cached input token、turn usage 和 budget 设计，把 usage、cache hit/miss 和 estimated cost 归一到一次 harness turn 的可观测结果；不采用 Claude Code 的 Anthropic `cache_control`。
- JD 对齐：把 LLM API、KV Cache、Agent Loop 和 Harness Engineering 的理解落到可演示字段，而不是只停留在账单 CSV 分析。
- 自动验证：`apps/web/lib/llm.test.ts` 覆盖 hit/miss token 聚合后的 `inputCacheHitRatio`；`packages/shared/src/architecture-bounds.test.ts` 锁住 LLM billing/cache 仍在 OpenClaw / Codex / Claude Code 上限内。

### LLM call budget warning

- 变更：playground 的 `harnessTrace.llm` 增加 `callBudget` 和 `warnings`，默认每轮预算 3 次 LLM 调用；超过时输出 `llm_call_budget_exceeded: <calls>/<budget>`。
- 设计选择：参考 Codex 的有界 loop 和可观测 trace，不引入 durable workflow、动态路由或复杂预算调度器。
- JD 对齐：把真实 pro 模型调用从“账单事后分析”前移到每轮 demo trace，便于解释 agent 是否收敛、是否可控、是否超预算。
- 自动验证：`apps/web/lib/llm.test.ts` 覆盖默认预算、自定义预算和超预算 warning。

### Pro usage and cost trace

- 变更：真实 DeepSeek pro 调用写入 model、calls、cache hit/miss tokens、output tokens、total tokens、estimated cost CNY 和 operation list。
- 设计选择：只保留 `deepseek-v4-pro` 主线，`deepseek-v4-flash` 映射回 pro；成本优化靠少调用、短输出、trace 可观测。
- JD 对齐：MVP demo 可以直接展示 agent 的模型成本和工具循环，不需要打开外部账单 CSV 才能解释系统行为。
- 自动验证：`packages/llm/src/chat-completions-adapter.test.ts` 和 `apps/web/lib/llm.test.ts` 覆盖 telemetry 聚合和环境模型映射。
