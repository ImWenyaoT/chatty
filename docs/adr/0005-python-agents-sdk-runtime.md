# Python Agents SDK 运行时

- 状态：Accepted（2026-07-19）
- 关联：GitHub #34、#35

Chatty 采用 Python 后端与薄 Next.js 前端。最高层边界保持为 **Agent = Model + Harness**：OpenAI Agents SDK 拥有通用 Agent Loop；Chatty Harness 拥有 Context、Tools、边界、执行与结果验证。模型通过 OpenAI-compatible Chat Completions 接口接入，默认 `deepseek-v4-pro`，关闭 thinking，使用非流式运行。

根目录 Python 应用使用 uv、FastAPI、`Runner.run` 与 `SQLiteSession`。依赖暂时约束为 `openai-agents==0.17.8`、`openai>=2.44,<2.45`，因为已验证的 SDK 版本与 OpenAI Python 2.45 及以上在 `cache_write_tokens` 字段上不兼容；升级前必须先移除该兼容性风险并重新运行契约测试。

#35 只建立一条无工具的最小纵切：同步 HTTP 请求内异步等待一次 Agent 运行，持久化 session，并写入不含敏感 payload 的本地 trace 摘要。知识、订单、长期 Memory、人工支持、完整 dashboard 和旧 TypeScript Harness 的收缩均由后续 ticket 完成。迁移期间旧 `packages/*` 仍保留为既有行为与测试依据，不代表存在两个生产 Agent Loop。
