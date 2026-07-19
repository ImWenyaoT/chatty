# Chatty 项目上下文

本文件是仓库唯一的架构与领域语言入口。Chatty 是一个用于简历展示的单 Agent 客服 MVP：Python/FastAPI 后端运行真实 Agent 路径，薄 Next.js 前端只提供 Playground、Dashboard 和 Orders 三个页面，SQLite 保存 demo 的业务事实与运行证据。

## 最高公理

**Agent = Model + Harness**。

- **Model** 理解客户意图，并在 OpenAI Agents SDK 的 Agent Loop 中选择下一步 Tool。
- **Harness** 提供可信 Context、有界 Tools、schema 与权限、真实执行、SQLite 持久化、运行边界、Trace 和完成验证。
- Harness 不使用关键词或正则表达式替 Model 做客服意图路由。
- 一段听起来合理的回复不是业务完成证据；真实 SQLite 状态、知识来源或可追踪 Handoff receipt 才是证据。

项目公理高于外部术语来源。其下，Agent 运行与 API 术语遵循 OpenAI Developers；AI coding 术语遵循 Dictionary of AI Coding。Python、TypeScript、SQLite、API、JSONL、eval 等必要技术词保持原名。

## 当前运行边界

- `src/chatty`：唯一活动后端；FastAPI 提供 API，OpenAI Agents SDK 提供 `Runner.run` 和 `SQLiteSession`。
- `apps/web`：薄前端；只调用 FastAPI，不直接访问 SQLite、调用 Model、执行 Tool 或判断完成。
- `knowledge/records.jsonl`：卖家验证的预分块知识，导入 SQLite FTS5 后由 `search_knowledge` 查询。
- `eval/cases.jsonl`：确定性回归场景；可控 Model 只替代外部 Model API，Runner、Tools、SQLite、Trace 和完成验证均走真实路径。
- `tests`：FastAPI + disposable SQLite 的公开行为测试。
- `docs/adr`：重要决策史和当前决策状态。

仓库不保留 TypeScript 后端、Next.js API routes 或内部 packages；TypeScript 只用于薄 web。

## 领域语言

**Chatty Agent**：Model 与 Chatty Harness 的整体。

**Agent Loop**：OpenAI Agents SDK 负责的 model → tool → result → model 循环。Chatty 不维护第二套 loop。

**Context**：当前 Run 所需的可信客户身份、Session、客户消息与业务依赖。请求或 Model 不能覆盖可信身份。

**Tool**：Model 可选择的有界业务能力。当前包括知识搜索、客户 Memory 搜索与保存、库存与订单操作、Handoff。

**Knowledge**：卖家验证、跨客户共享、带来源的事实。它不是 Agent Instructions、客户 Memory 或原始对话。

**Customer Memory**：客户明确表达、跨交易稳定、带 Trace 来源的事实。临时需求、推断画像和自动抽取不进入 Memory。

**Business Outcome**：Tool 执行后由 Harness 依据 SQLite 状态或结构化结果验证的结果。`verified` 表示业务操作有证据，`not_completed` 表示尝试失败，`not_applicable` 表示普通回复无需业务副作用。

**Handoff**：持久化到 SQLite 的人工支持请求，包含问题、Context、既有动作与 receipt。仅回复“请联系客服”不算 Handoff。

**Trace**：本地保存的 Run 与 span 安全摘要，包括 Model、Tool、结果、错误和完成证据；默认不记录敏感 payload。

**eval**：通过 JSONL 场景验证可观察 Agent 行为的回归门禁。确定性 eval 在 CI 运行；真实 DeepSeek contract 仅在显式 opt-in 且提供凭据时运行。

## 不在 MVP 范围内

生产电商、认证、多租户、支付、远程部署、multi-agent、RAG/vector database、streaming、后台任务系统与生产可用性承诺均不在范围内。
