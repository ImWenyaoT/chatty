# 最终平台收缩

- 状态：部分被取代（2026-07-20）
- 关联：GitHub #34、#42

> 本 ADR 记录 Python 阶段的平台收缩。单 Agent Loop 和不增加通用平台的决定仍然有效。当前运行时见 ADR 0010 和 0012。当前产品入口见 ADR 0013。

当时的活动实现只有一个 Python 后端和一个 Next.js Web。Python/FastAPI、OpenAI Agents SDK 和 SQLite 提供 Agent、Harness、Tools、业务数据、Session、Trace 和 eval。OpenAI Agents SDK 拥有唯一 Agent Loop。

当时的 `apps/web` 只保留 Playground、Dashboard、Orders 和导航。页面通过 HTTP 调用 FastAPI，不直接读取 SQLite，也不实现 Agent 逻辑。

该阶段删除了被替代的 TypeScript 后端、worker、jobs、outbox、checkpoint、control plane 和 provider router。后续的 TypeScript 迁移重新建立了当前 package 边界。

2026-07-20 开始的增量 TypeScript 迁移由 ADR 0010 接管运行时语言与 pnpm workspace 决策；本 ADR 对薄 Web、单 Agent Loop 和禁止恢复通用平台机制的收缩仍然有效。

知识的活动输入只有 `knowledge/records.jsonl`，确定性 eval 的活动输入只有 `eval/cases.jsonl`。旧材料可由 Git 历史追溯，不作为并行运行时、架构 Context 或当前质量门禁保留。
