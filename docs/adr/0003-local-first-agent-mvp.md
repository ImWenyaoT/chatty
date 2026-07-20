# 本地一体化客服 Agent MVP

- 状态：部分被取代（2026-07-19）

> Python Agent 运行时与分阶段迁移策略由
> [ADR-0005](0005-python-agents-sdk-runtime.md) 取代；当前 single-context 范围由
> [ADR-0007](0007-single-context-eval-and-project-boundary.md) 定义；前端实现以
> [ADR-0009](0009-thin-react-vite-web.md) 为准。本 ADR 对本地业务系统和可验证结果的产品约束仍然有效。

## 仍然有效的决定

Chatty 使用 SQLite 保存商品、库存、订单、Session、Memory、Handoff 与 Trace。验收重点是 Model 通过 Harness Tools 取得可验证结果并持久化证据，而不是接入生产级远程数据库或第三方客服系统。固定返回“有货”等未读取业务状态的响应不算完成。

业务后端只实现客服演示所需的简化电商逻辑：商品与尺码数量、租赁日期占用、买断出库和必要订单状态，使用 SQLite 事务保证结果可验证。Model 根据对话理解租赁或买断意图，歧义时向客户确认；Harness 只验证 Tool schema、权限、执行结果和完成条件。支付、仓储和履约平台均不在范围内。

## 已被取代的部分

最初的 TypeScript 全栈、Next.js API、follow-up 与 Demo Adapter 方案不再有效。其后的 Python/FastAPI 后端与薄 web 边界由 ADR 0005、0007、0008 收缩，当前前端实现见 ADR 0009。
