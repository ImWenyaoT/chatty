---
status: accepted
---

# 扁平化为单包，顶层目录按领域切分

#63 引入 `apps/` + `packages/` 工作区布局，#64 在其上做了 Hono RPC。工作区当时要解决的
问题是「代码没有边界」。实践下来发现，边界可以由顶层领域目录直接表达；`--filter` 编排、
三份 `package.json`、`workspace:` 协议依赖是多包带来的额外成本，不是边界本身。

现在扁平化为单包，只保留一份根 `package.json`，源码统一放在 `src/` 并按职责切分：

```
src/
├── agent/     Agent 表面与 Harness 实现
├── data/      SQLite 与种子数据
├── server/    Hono HTTP 层与进程入口
├── web/       Vite + React 前端
└── evals/     行为评测
tests/         单元测试
```

## 参考来源

布局参考 eve 的 filesystem-first 思路，但 Chatty 不是 eve project。Chatty 使用 OpenAI Agents
SDK 和自己的 Harness，因此采用普通 TypeScript full-stack 的 `src/` 布局，只借用清晰分隔
Agent authored surface 的原则，不复制 eve compiler 的文件发现机制。

`src/agent/` 保留 `agent.ts`、`instructions.md`、`tools/` 与 `subagents/` 这些有实际语义的
authored slot。`tools/` 一文件一个模型 Tool，由 `agent.ts` 静态 import；不实现目录扫描、registry
或恒等 `define-*` 包装。只有出现多个真实扩展点时才增加相应 seam。

eve 的其余 slot 明确不采纳：

- `channels/`：只有一个 Hono HTTP 面，为它建一个单文件目录是仪式。
- `sandbox/`：没有代码执行需求。
- `schedules/`、`connections/`、`hooks/`、`instrumentation.ts`：都在项目边界之外。
- `skills/`：营销策略是 SQLite 里的数据，不是 Markdown 文档。

## 代价

这是仓库布局的第五次调整，需要在 git log 上说明它不是反复横跳。#63 的目标是「代码有边界」，
这个目标在新布局下由顶层领域目录达成；工作区只是当时选中的手段，不是目标本身。换掉的是手段。

## 影响

- ADR 0001 被本 ADR 部分取代。它描述的前后端分层决策仍然有效，变的只是路径：
  `apps/web/` 成为 `src/web/`，`apps/api/` 拆到 `src/server/`、`src/agent/`、`src/data/`。
- CI 不受影响。`.github/workflows/ci.yml` 只跑 `pnpm run check`，与目录路径无关。
- 根 `package.json` 的 script 不再需要 `--filter`；两份子包 `package.json` 已删除。
  `pnpm-workspace.yaml` 只保留 pnpm 的依赖构建许可，不再声明 workspace package。
