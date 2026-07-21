# Python Agents SDK 运行时

- 状态：已被 ADR 0010 和 ADR 0012 取代（2026-07-21）
- 关联：GitHub #34、#35、#41

> 本 ADR 记录已经删除的 Python/FastAPI 运行时。当前实现使用全栈 TypeScript。见 [ADR-0010](0010-incremental-typescript-runtime-migration.md) 和 [ADR-0012](0012-nextjs-agent-runtime.md)。

该阶段采用 Python 后端和 Next.js 前端。最高层边界保持为 **Agent = Model + Harness**。OpenAI Agents SDK 拥有 Agent Loop。Chatty Harness 拥有 Context、Tools、执行边界和结果验证。模型通过 OpenAI-compatible Chat Completions 接口接入。

当时的根目录 Python 应用使用 uv、FastAPI、`Runner.run` 和 `SQLiteSession`。依赖固定为 `openai-agents==0.17.8` 和 `openai>=2.44,<2.45`。OpenAI Python 2.45 及以上与该版本 SDK 的 `cache_write_tokens` 字段不兼容。

#35 最初只建立没有 Tool 的最小路径。#36 至 #41 加入知识、订单、显式客户 Memory、Handoff、Dashboard 和 eval。#42 删除了当时的 TypeScript 后端，因此 Python 成为该阶段的唯一后端。
