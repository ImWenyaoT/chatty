# Model 选择 Tool，Harness 负责执行边界

- 状态：部分被取代（2026-07-19）
- 取代：ADR 0001 中“由 Harness 在模型调用前确定任务与唯一工具”的部分
- 当前决定：Model 选择 Tool 的边界仍有效。当前运行时与产品范围见 ADR 0012 和 0013

Chatty 将用户输入、Context 和有界 Tools 交给单一 Model，由 Model 理解意图并选择下一步；Harness 负责工具可见性、schema、权限、真实执行、业务不变量、运行保护和完成验证。此前的正则意图路由会提前替 Model 决策，因此删除；OpenAI Agents SDK 的 `Agent`、function tools 和 `Runner` 循环作为实现下限。

## 边界

- 这是单 Agent MVP，不引入 Multi-Agent runtime 或通用 workflow engine。
- 以 `learn-claude-code` 的最小 agent loop 为起点做必要加法，而不是从完整 Claude Code 逐项裁剪。
- 简化实现不得改变对外行为：库存查询、订单、知识搜索、可追踪 Handoff、显式 Memory 和完成验证仍由真实工具闭环支撑。
- SDK 已提供的 loop、tool calling 与运行保护直接复用；只有业务边界才留在 Chatty Harness。

## 已被取代的部分

早期方案曾包含 Durable Task、follow-up、Execution Control、Handoff Resolution 和通用 Task CRUD。最终收缩后的简历 MVP 不实现这些机制；Handoff 只保留为带 receipt 的 SQLite 记录，不构成后台任务系统。当前范围以 ADR 0007、0008 为准。

## 后果

新增能力时先定义 Tool、权限和可验证结果。Model 在 Agent Loop 中选择 Tool。Harness 不得使用关键词提前选择业务路径，也不得增加第二套 Agent Loop。
