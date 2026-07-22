# 窄工具承载 Harness 不变量

- 状态：Accepted（2026-07-22）
- 关联：ADR 0001（Harness 参考 claude code）、ADR 0013（内容工作台）

Agent 工具设计有一条通行原则：优先提供通用工具（代码解释器、文件读写），让 Model 通过组合基础能力解决问题，而不是为每个任务设计专用工具。该原则在**解空间无法预先枚举**时成立：组合能覆盖设计者没有想到的情况。

Chatty 不采用该原则来设计业务工具。原因是 Chatty 的解空间可以枚举，而通用性会换掉 Harness 的两项核心能力：最小权限与可验证性。

## 决策

写入权威状态的工具保持窄口径：strict 参数、单一业务语义、产出可核验的回执。不提供通用代码执行、通用 SQL 或通用写入工具作为业务路径。

窄口径不是实现细节，它承载不变量。以下不变量只能由工具边界表达，无法由通用工具表达：

- `save_research_artifact`：每条 claim 的 `source_ids` 必须出现在本次 run 的知识检索结果中。
- `save_customer_memory`：fact 必须是客户消息的逐字子串（`str.casefold()` 折叠后比较）。
- `view_order` / `confirm_order` / `cancel_order`：先校验 `order.customer_id` 等于 Harness 注入的身份。Model 不能指定身份。
- `export_artifact`：要求 artifact 处于 `approved`，即已经过人工批准，并写入 sha256 内容哈希的 delivery receipt。

Harness 的 `verify_business_outcome` 在 run 结束后重读 SQLite 复核这些结果。该复核之所以有意义，正是因为业务操作存在一套可枚举的词汇表可供对照。若业务路径改为任意 SQL 或任意代码执行，复核失去比对对象，Harness 退化为转发器。

## 边界与例外

该决策只约束写入权威状态的路径。读取与分析路径不受此约束：只要不触及权威状态，通用计算能力可以引入。

判据是能力而非工具形态：一个工具若无法修改 SQLite 中的订单、artifact、memory、handoff 与 trace，则不受本 ADR 约束。

## 后果

新增业务能力需要新增一个窄工具，并同时指明它承载的不变量与回执形状。这比暴露通用能力昂贵，是刻意付出的代价。

评审本仓库时若出现"把 N 个业务工具合并为一个通用工具"的简化提议，应先确认上述不变量在新设计中如何表达；无法表达则拒绝该提议。
