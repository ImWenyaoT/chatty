# 本地一体化客服 Agent MVP

- 状态：部分被取代（2026-07-19）

> 本 ADR 记录最初的客服 MVP。当前运行时见 [ADR-0010](0010-incremental-typescript-runtime-migration.md) 和 [ADR-0012](0012-nextjs-agent-runtime.md)。当前产品入口见 [ADR-0013](0013-agent-research-content-workbench.md)。本 ADR 对本地数据和完成验证的要求仍然有效。

## 仍然有效的决定

Chatty 使用 SQLite 保存商品、库存、订单、Session、Memory、Handoff 与 Trace。验收重点是 Model 通过 Harness Tools 取得可验证结果并持久化证据，而不是接入生产级远程数据库或第三方客服系统。固定返回“有货”等未读取业务状态的响应不算完成。

业务后端只实现客服演示所需的简化电商逻辑：商品与尺码数量、租赁日期占用、买断出库和必要订单状态，使用 SQLite 事务保证结果可验证。Model 根据对话理解租赁或买断意图，歧义时向客户确认；Harness 只验证 Tool schema、权限、执行结果和完成条件。支付、仓储和履约平台均不在范围内。

## 已被取代的部分

早期 TypeScript 实现已经删除。项目后来使用 Python/FastAPI，并在 ADR 0010 中迁移到新的 TypeScript Agent runtime。当前 Next.js 入口见 ADR 0012 和 0013。
