# ADR 0001 — Claude Code 仅作为行为参考

- 状态：Superseded in part（2026-07-18）
- 原决定日期：2026-07-12
- 当前决定：见 ADR 0002、0003、0004

## 历史背景

Chatty 最初直接参考完整 Claude Code 的 Harness 形状，用它帮助识别 Agent Loop、Tool Use、权限、Context、Trace 与恢复等机制。这个参考纠正了早期把 Chatty 做成“工作流加回复生成器”的方向，但也把与客服 MVP 无关的控制面复杂度带入了实现。

## 当前修正

完整 Claude Code 只保留为行为参考，不再是 Chatty 的复杂度预算或实现模板。当前实现从 `learn-claude-code` 的最小 Agent Loop 正向增加 Chatty 必需能力；OpenAI Agents SDK 已经提供的 model → tool → result → model 循环是实现下限，不再维护第二套自建 loop。

以下边界取代本 ADR 的旧实现建议：

- Chatty 是单 Agent：Model 负责理解意图和选择工具，Harness 负责工具边界、可信身份、权限、执行、验证与证据。
- 不引入 subagent、agent team、worktree、MCP、通用 workflow engine 或 Claude Code 专属基础设施。
- 同步任务只需要 Trace；只有等待客户、人工、时间或前置依赖的工作才创建 Durable Task。
- SQLite 是 MVP 的真实本地业务系统，商品、库存、订单、Handoff 与 Memory 资格都以持久状态验证。
- Knowledge Base、Transaction Context、Long-term Customer Memory 与 Agent Instructions 是四个不同概念，不互相代偿。

## 保留的结论

仍然保留 Claude Code 展示出的通用原则：Agent 不是一次模型调用；工具结果必须回到同一 Model Loop；确定性工作交给工具；运行必须有边界、证据和可验证终点。Chatty 只实现客服场景实际需要的最小版本。

## 后果

当前架构以 ADR 0002 的 Model-directed Task Scheduling、ADR 0003 的本地 SQLite Agent MVP、ADR 0004 的复购客户 Memory 门槛为准。任何新增机制都必须先证明它是现有可观察行为所需，而不能以“Claude Code 也有”为理由进入 Chatty。
