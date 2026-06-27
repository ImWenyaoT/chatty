# AGENTS.md

## Collaboration

- 请保持对话语言为中文。
- 项目级 Codex workflow skills 必须放在 `.agents/skills/`。
- 非平凡或高风险开发完成前，至少安排一次只读 sub-agent grill 主代理；协作结构保持树形，sub-agents 只向主代理回报。
- 可以复用或改造合适的开源 skills，但必须记录来源、许可、兼容性和本项目改造点，避免直接混入不明来源流程。
- Runtime customer-service 概念不要叫 `skills`；使用 `tools`、`playbooks`、`policies`、`knowledge`。
- 改变架构、loop 行为、memory/trace 语义、legacy 兼容路径前，先读 `docs/loop-engineering-plan.md` 和相关源码。
- 行为变更先补或更新测试，再实现。

## Setup Commands

- Install deps: `npm ci`
- Run tests: `npm test`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Legacy compatibility build: `npm run build:rag-service`

## Code Style

- 生成代码时添加函数级注释。
- TypeScript 代码使用 single quotes, no semicolons。
- 保持包边界清晰：route handler 不直接依赖模型 SDK 细节，`agent-core` 通过 `packages/llm` 接口工作。

## Testing Instructions

- 改 `packages/agent-core`：至少跑 `npm --workspace @rental/agent-core run test` 和 `npm run typecheck:skeleton`。
- 改 `packages/db`：至少跑 `npm --workspace @rental/db run test` 和 `npm run typecheck:skeleton`。
- 改 `apps/web`：至少跑 `npm --workspace @chatty/web run typecheck` 和 `npm --workspace @chatty/web run build`。
- 改 `rag-service` 或 legacy adapter：跑 `npm run build:rag-service`，必要时再跑全量 `npm run build`。
- 提交前默认跑 `npm test`、`npm run typecheck`、`npm run build`。
