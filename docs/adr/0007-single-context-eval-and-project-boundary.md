# Single-context eval 与简历项目边界

- 状态：部分被 ADR 0010、0012 和 0013 取代（2026-07-21）
- 关联：GitHub #34、#41
- 取代：ADR 0002 的 Durable Task、follow-up 与 Execution Control 设计；ADR 0003 的 TypeScript 运行时描述

> 本 ADR 的单次请求、eval 和项目边界仍然有效。Python/FastAPI 和旧页面属于历史实现。

Chatty 使用根 `CONTEXT.md` 作为唯一架构与领域语言入口。`docs/adr` 保留重要决策史，但 package、app、eval 与 retrieval 不再建立并行 Context 文档。最高公理保持为 **Agent = Model + Harness**；其下，Agent 运行与 API 术语遵循 OpenAI Developers，AI coding 术语遵循 Dictionary of AI Coding。

当前 MVP 使用一个同步的 TypeScript Agent 请求。Next.js Route Handler 在一次请求内等待 OpenAI Agents SDK `Runner.run`。Harness 提供 Tools、SQLite 操作、Trace 和完成验证。`/workbench` 是产品入口。定时任务、通用任务图和生产控制设施不属于当前 MVP。Handoff 只表示已经保存的人工支持请求。

确定性 eval 使用 JSONL 用例和可控 Model。CI 运行真实的 HTTP application、Runner、Tool、SQLite、Trace 和完成验证代码。真实 DeepSeek 测试只在手动任务中运行。Secret 不得进入输出或 Trace。

README 只描述本地可运行且可验证的能力。项目不承诺生产规模、可用性、安全合规或外部平台交付。
