# Python Agents SDK 运行时

- 状态：Accepted（2026-07-19）
- 关联：GitHub #34、#35、#41

> 本 ADR 的 Python Agent 运行时决定仍然有效；Next.js 实现细节由 [ADR-0009](0009-thin-react-vite-web.md) 取代。

Chatty 采用 Python 后端与薄 Next.js 前端。最高层边界保持为 **Agent = Model + Harness**：OpenAI Agents SDK 拥有通用 Agent Loop；Chatty Harness 拥有 Context、Tools、边界、执行与结果验证。模型通过 OpenAI-compatible Chat Completions 接口接入，默认 `deepseek-v4-pro`，关闭 thinking，使用非流式运行。

根目录 Python 应用使用 uv、FastAPI、`Runner.run` 与 `SQLiteSession`。依赖暂时约束为 `openai-agents==0.17.8`、`openai>=2.44,<2.45`，因为已验证的 SDK 版本与 OpenAI Python 2.45 及以上在 `cache_write_tokens` 字段上不兼容；升级前必须先移除该兼容性风险并重新运行契约测试。

#35 最初只建立无 Tool 的最小纵切；#36 至 #41 已在同一路径加入知识、订单、显式客户 Memory、Handoff、Dashboard 与 eval。#42 已删除被替代的 TypeScript 后端；Python 是唯一活动后端。
