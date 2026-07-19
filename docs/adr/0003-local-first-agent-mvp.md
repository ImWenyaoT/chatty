# 本地一体化客服 Agent MVP

- 状态：部分被取代（2026-07-19）

> Python Agent 运行时与分阶段迁移策略由
> [ADR-0005](0005-python-agents-sdk-runtime.md) 取代；当前 single-context 范围由
> [ADR-0007](0007-single-context-eval-and-project-boundary.md) 定义。本 ADR 对本地业务系统和可验证结果的产品约束仍然有效。

Chatty 的 MVP 是 TypeScript 全栈、Next.js Web/API 与 SQLite 本地业务系统组成的可运行客服 Agent demo。验收重点是 Model 通过 Harness 工具完成可验证的业务结果并持久化证据，而不是接入生产级远程数据库或第三方客服系统；本地 handoff、follow-up、memory、trace 与知识检索因此都属于真实 MVP 能力。商品、库存和客户资料可以使用编造或脱敏的 Demo Business Data，但这些记录必须进入 SQLite，并由 Demo Adapter 完成真实读写；固定返回“有货”等未读取业务状态的响应不算完成。

业务工具后端只实现常见电商平台逻辑的简化版：商品与尺码数量、租赁日期占用、买断出库以及必要的订单状态，全部使用 SQLite 事务保证结果可验证。Fulfillment Mode 由 Model 根据对话理解，歧义时向客户确认；Harness 只验证工具 schema、权限、执行结果和完成条件。Chatty 不继续设计支付、仓储、履约等电商平台架构，这些都属于可替换的 Business Tool Backend，而不是 Agent/Harness 核心。
