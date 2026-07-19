# Single-context eval 与简历项目边界

- 状态：Accepted（2026-07-19）
- 关联：GitHub #34、#41
- 取代：ADR 0002 的 Durable Task、follow-up 与 Execution Control 设计；ADR 0003 的 TypeScript 运行时描述

Chatty 使用根 `CONTEXT.md` 作为唯一架构与领域语言入口。`docs/adr` 保留重要决策史，但 package、app、eval 与 retrieval 不再建立并行 Context 文档。最高公理保持为 **Agent = Model + Harness**；其下，Agent 运行与 API 术语遵循 OpenAI Developers，AI coding 术语遵循 Dictionary of AI Coding。

当前 MVP 是同步 Python Agent path：FastAPI 在一次请求内等待 OpenAI Agents SDK `Runner.run`，Harness 提供有界 Tools、SQLite 业务操作、本地 Trace 与完成验证。薄 Next.js 前端只保留 Playground、Dashboard 和 Orders 三个演示页面。等待客户、定时执行、通用任务图与生产控制设施不属于当前 MVP；Handoff 只表示已持久化、可追踪的人工支持请求。

确定性 eval 使用 JSONL cases 和可控 Model boundary，并在 CI 中运行真实 FastAPI、Runner、Tool、SQLite、Trace 与完成验证路径。真实 DeepSeek contract 只在显式 opt-in 时运行，配置仍只有 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL_ID`，thinking 关闭，secret 不进入输出或 Trace。

README 只承诺本地可运行、可验证的简历项目能力，不对生产规模、可用性、安全合规或外部交付作保证。迁移遗留 TypeScript 生产代码由 #42 删除，不在本 ADR 提前处理。
