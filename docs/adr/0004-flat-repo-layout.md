---
status: accepted
---

# 扁平化为单包，顶层目录按领域切分

#63 引入 `apps/` + `packages/` 工作区布局，#64 在其上做了 Hono RPC。工作区当时要解决的
问题是「代码没有边界」。实践下来发现，边界可以由顶层领域目录直接表达；`--filter` 编排、
三份 `package.json`、`workspace:` 协议依赖是多包带来的额外成本，不是边界本身。

现在扁平化为单包，只保留一份根 `package.json`，顶层目录按领域切分：

```
agent/     Agent 表面（instructions / tools / subagents / lib）
data/      SQLite 与种子数据
server/    HTTP 层与进程入口
web/       Vite + React 前端
evals/     行为评测
tests/     单元测试
```

## 参考来源

布局参考 vercel-labs/steve，即 eve 框架的自托管参考实现。steve 是单包，根目录直接是
`agent/`、`app/`、`evals/`。我们采纳了它的组织原则，但抽掉了依赖 eve 运行时的部分
（`channels/`、`sandbox/`、`deploy/`、`docker-compose`）。

`agent/` 的内部 slot 约定来自 eve 的 Project Layout 规范：`agent.ts`、`instructions.md`、
`tools/`、`subagents/`、`lib/`，并且**路径决定身份**——文件名即 tool 名，不需要另一份注册表
把文件和名字对起来。

eve 的其余 slot 明确不采纳：

- `channels/`：只有一个 HTTP 面，为它建一个单文件目录是仪式。
- `sandbox/`：没有代码执行需求。
- `schedules/`、`connections/`、`hooks/`、`instrumentation.ts`：都在项目边界之外。
- `skills/`：营销策略是 SQLite 里的数据，不是 markdown 文档。

## 代价

这是仓库布局的第五次调整，需要在 git log 上说明它不是反复横跳。#63 的目标是「代码有边界」，
这个目标在新布局下由顶层领域目录达成；工作区只是当时选中的手段，不是目标本身。换掉的是手段。

## 影响

- ADR 0001 被本 ADR 部分取代。它描述的前后端分层决策仍然有效，变的只是路径：
  `apps/web/` 成为 `web/`，`apps/api/` 拆到 `server/`、`agent/`、`data/`。
- CI 不受影响。`.github/workflows/ci.yml` 只跑 `pnpm run check`，与目录路径无关。
- 根 `package.json` 的 script 不再需要 `--filter`；`pnpm-workspace.yaml` 与两份子包
  `package.json` 一并删除。
