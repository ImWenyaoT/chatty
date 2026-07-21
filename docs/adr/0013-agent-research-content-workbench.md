# 单 Agent 研究与内容工作台

- 状态：Accepted（2026-07-21）
- 依赖：ADR 0012 的 Next.js 唯一入口

## 决策

Chatty 从客服优先界面转为单 Agent 研究与内容生产 MVP。最高层边界仍是 **Agent = Model + Harness**，唯一 Agent Loop 仍使用 OpenAI Agents SDK 的 `Agent + Runner`。

Model 可以选择 `search_knowledge`、`save_research_artifact`、`save_content_artifact` 和 `export_artifact`。Harness 要求 Claim 来源来自本次检索。Harness 保存并重新读取 Artifact，然后检查 Research Artifact 与 Content Artifact 的来源关系。只有服务端记录为已批准的 Artifact 才能导出。Model 没有批准 Tool。

主链路为：

1. 本地 Knowledge 检索；
2. 带 Claim/source、产业节点、关系和未知项的 Research Artifact；
3. 只能引用上游 Claim 的 Content Artifact；
4. 人工在 Workbench 批准；
5. 导出到 sandbox 并生成带 SHA-256 的 delivery receipt。

外部 Skill 仓库是设计参考，不是运行时依赖。Chatty 使用其中的问题拆解、阶段产物、来源约束和验收方法。Chatty 不增加 Skill loader、catalog、workflow engine、插件市场或 Multi-Agent runtime。

## MVP 边界

小红书、抖音和公众号只表示内容格式。没有真实平台授权或发布，没有实时行情、投资建议、向量数据库、产业图数据库和模型微调。Web 只保留任务、Artifact、人工批准和完成证据，不扩展为营销 SaaS 后台。

## 迁移与回滚

- C1：Add-only Artifact schema/Module 与 focused tests；旧客服行为不变。
- C2：新增固定 Tools、eval 和 `/workbench`；旧 Web/API 仍可用。
- C3（当前）：根路径与旧 Web 路由转向 Workbench；旧 Orders API、SQLite 表、Tools 和测试作为兼容层保留。
- C4（后续）：真实 provider、备份恢复与新场景稳定后，单独删除旧 Orders/Commerce 兼容层。

C3 回滚只需恢复旧 Web 路由；Artifact 表是 add-only，不影响旧读取。跨越 TypeScript runtime 切换回滚时，仍必须同时恢复迁移前代码 revision `1c350fc382119c52431e1f050b616e340c1df026` 与匹配的 SQLite 备份，禁止不同代码版本并发写同一数据库。
