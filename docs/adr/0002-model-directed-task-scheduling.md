# Model 负责 Task Scheduling，Harness 负责执行边界

- 状态：Accepted（2026-07-18）
- 取代：ADR 0001 中“由 Harness 在模型调用前确定任务与唯一工具”的部分

Chatty 将用户输入、上下文和有界业务工具交给单一 Model，由 Model 识别意图并选择下一步；Harness 只负责工具可见性、schema、权限、真实执行、业务不变量、运行保护和 Task Completion。此前的正则意图路由会提前替 Model 决策，使系统退化为“规则工作流 + LLM 文案层”，因此删除；OpenAI Agents SDK 的 `Agent`、function tools 和 `Runner` 循环作为实现下限。

## 边界

- 这是单 Agent MVP，不引入 multi-agent、通用 workflow engine 或 Web 产品架构。
- 以 `learn-claude-code` 的最小 agent loop 为起点做必要加法，而不是从完整 Claude Code 逐项裁剪。
- 简化实现不得改变对外行为：库存查询、知识搜索、可追踪 handoff、follow-up、memory patch 和完成验证仍由真实工具闭环支撑。
- SDK 已提供的 loop、tool calling 与运行保护直接复用；只有业务边界才留在 Chatty Harness。

## Task System

Task Scheduling 与 Durable Task System 是两层：前者是 Model 在当轮选择下一步工具，后者只持久化无法在当轮完成的目标。简单问答、知识搜索和同步库存查询完成后只留下 Trace；等待客户、定时跟进、人工 Handoff 或存在前置依赖的工作才创建 Durable Task。Task System 以 `learn-claude-code/s12_task_system` 的 Model-driven task tools 与最小生命周期为起点，使用 SQLite 适配本地 MVP，不引入 multi-agent 协调复杂度。

这里的 Model-visible task tools 是领域动作 `request_customer_information`、`create_handoff` 和 `schedule_followup`；通用 Task CRUD 与状态迁移只属于 Harness。现有每轮 run/event 记录是为幂等重放、跨进程取消、FIFO 与恢复保留的 Execution Control Compatibility，不代表客户目标，也不属于 Durable Task。

Chatty 的身份、工具使用规则、安全边界、升级规则和完成纪律属于始终加载的 Agent Instructions，概念上对应 Chatty 自己的运行时 `AGENTS.md`，由 s10 风格的 system-prompt sections 组装；它们不进入 Memory，也不依赖 Knowledge Base 检索才能生效。

Handoff 有两个入口但一个持久化结果：Model 可以根据客户意图或需要人工判断主动调用 Handoff；当权限要求人工审批、受限业务无法安全完成或工具的安全恢复已耗尽时，Harness 必须强制创建同一种 Durable Handoff。两者都保存问题、上下文、既有动作与状态，等待人工认领和恢复，不能只返回“请联系人工客服”。

人工认领后提供的是 Handoff Resolution，而不是另开一条脱离 Harness 的客服会话。Resolution 作为可信判断、授权或事实写回原 Durable Task；同一个 Chatty Agent 恢复执行，必要时继续调用业务工具，最终由 Agent 回复客户并完成任务。
