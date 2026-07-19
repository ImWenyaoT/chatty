# 客户 Memory 只保存显式稳定事实

- 状态：Accepted（2026-07-19）
- 关联：GitHub #34、#38
- 取代：[ADR-0004](0004-repeat-customer-memory.md)

Chatty 的简化 MVP 只在 Model 主动选择 bounded Tool 时保存客户明确表达、且跨交易稳定的事实。Harness 通过 FastAPI dependency 从可信身份 Context 注入 `customer_id`，请求 payload、URL 与 Model 均不能提供或覆盖它；Harness 同时绑定 Session 与客户，以当前 Trace 作为来源，并验证保存的事实是本轮客户消息中的原文。每条 Memory 在 SQLite 中保留事实、客户、来源和创建时间，并只通过同一客户范围内的简单词法搜索 Tool 供以后 Session 使用。本地 demo 默认使用固定的 `demo-customer` dependency，生产认证不属于 MVP 范围。

Tool schema 要求事实同时标记为显式与稳定，因此临时交易需求和 Model 推断不能写入。系统不自动抽取或整合 Memory，也不建立 repeat-customer gate、Memory Candidate、confidence、审核队列、embedding 或向量索引。Playground 只展示本次运行的 Memory Tool 结果及来源，不承担 Memory 业务逻辑。
