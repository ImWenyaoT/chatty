# Chatty Changelog

本文件记录和 JD / PRD 对齐的架构、测试、可观测性改动。发布级变更仍以 git commit 为准。

## 2026-07-05

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
