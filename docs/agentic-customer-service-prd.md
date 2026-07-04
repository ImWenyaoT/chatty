# Agentic Customer Service PRD（决策记录）

Last updated: 2026-07-04

原 504 行探索版 PRD 已归档：全文见本文件的 git 历史
（`git log --follow -- docs/agentic-customer-service-prd.md`）或 `legacy-extras` 分支。
现行架构以 [architecture.md](architecture.md) 与
[tech-stack-decisions.md](tech-stack-decisions.md) 为准。此处仅保留两条被否决方案的决策记录：

## 否决：Chatwoot + Agent Sidecar 作为主基座

原 PRD 推荐用 Chatwoot 作客服壳（inbox/会话/分配/转人工），agent 以 sidecar 挂载。
否决原因：MVP 不需要完整 helpdesk 产品面，引入 Rails 运行时 + Chatwoot 部署/数据库的
成本远大于收益；本项目的信号在 harness 工程本身而非客服后台复刻。
Chatwoot 降级为产品概念参考（inbox/assignment/internal note 等词汇），不进运行时。

## 否决：LangGraph 作为 agent 编排运行时

原 PRD 把 LangGraph 列为 durable graph 编排候选（状态持久化、可恢复 run、human-in-the-loop）。
否决原因：MVP 的 loop 是"每请求一次有界步"，不需要 durable workflow 运行时；
自建有界 loop + OpenAI Agents SDK TS（工具/护栏/追踪）即可覆盖，
待产品证明需要持久化编排时再评估（同一理由下 Temporal 也被推迟）。
