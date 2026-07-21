# 客户 Memory 只保存显式稳定事实

- 状态：部分被取代（2026-07-21）
- 关联：GitHub #34、#38
- 取代：[ADR-0004](0004-repeat-customer-memory.md)

> Memory 规则仍然有效。Python/FastAPI 和旧 Web 页面已经删除。当前身份注入和 Tool 执行见 ADR 0010、0012 和 0013。

Chatty 只在 Model 选择 `save_customer_memory` 时保存客户事实。该事实必须由客户明确表达，并且能在不同交易中保持稳定。

HTTP application 提供 `customer_id`。请求和 Model 不能覆盖该值。Harness 绑定 Session 与客户，并使用当前 Trace 作为来源。每条 Memory 在 SQLite 中保存事实、客户、来源和创建时间。`search_customer_memory` 只查询同一客户的数据。默认身份是 `demo-customer`。生产认证不属于 MVP 范围。

Tool schema 要求事实标记为显式和稳定。临时需求、Model 推断和用户画像不能写入 Memory。系统不自动提取或合并 Memory。它也不使用 embedding、向量索引或审核队列。
