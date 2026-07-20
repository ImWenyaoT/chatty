# 最终平台收缩

- 状态：Accepted（2026-07-19）
- 关联：GitHub #34、#42

> 本 ADR 的平台收缩决定仍然有效；Next.js 实现细节由 [ADR-0009](0009-thin-react-vite-web.md) 取代。

Chatty 的活动实现只有一个 Python 后端与一个薄 Next.js web。Python/FastAPI、OpenAI Agents SDK 与 SQLite 共同提供 Agent、Harness、Tools、业务事实、Session、Trace 和 eval；OpenAI Agents SDK 拥有唯一 Agent Loop。

`apps/web` 只保留 Playground、Dashboard、Orders 与必要导航。页面只通过 HTTP 调用 FastAPI，不包含 Next.js API routes，不直接读取 SQLite，也不实现 Tool、Memory、完成判断或 Model provider 逻辑。根路由仅跳转到 Playground。

删除被替代的 TypeScript backend packages、worker、jobs、outbox、checkpoint、control plane、provider router、旧 release packaging 和对应测试。pnpm workspace 只用于从根目录管理唯一的 `apps/web`，不表达内部 package 边界。

知识的活动输入只有 `knowledge/records.jsonl`，确定性 eval 的活动输入只有 `eval/cases.jsonl`。旧材料可由 Git 历史追溯，不作为并行运行时、架构 Context 或当前质量门禁保留。
