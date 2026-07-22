# 回归 Python/FastAPI runtime 与 Vite 前端

- 状态：Accepted（2026-07-21）
- 取代：ADR 0010 的 TypeScript runtime 决定、ADR 0011 的 Next.js 前端决定、ADR 0012 的 Next.js HTTP 入口决定

## 决定

Chatty 后端按当前 TypeScript 设计（ADR 0013 的内容工作台产品语义）全新重写为 Python/FastAPI + Python OpenAI Agents SDK。前端保留 React、Tailwind CSS v4、shadcn/ui 与 TypeScript，宿主从 Next.js 换回 Vite SPA。

动机（按优先级）：

1. 求职 JD 匹配 Python/FastAPI 技术栈，简历信号密度优先。
2. 维护者个人更熟 Python，后续迭代速度优先。
3. Python 版 openai-agents 是原生 SDK，生态与示例更丰富，Pydantic 校验更成熟。

## 边界

- **产品语义不变**：`Agent = Model + Harness`、五步主流程（Knowledge 检索 → Research Artifact → Content Artifact → 人工批准 → sandbox delivery receipt）、Harness 重新读取 SQLite 验证完成证据，全部按 ADR 0013 保持。
- **重写不是回滚**：`1c350fc` 的旧 Python 代码只作 openai-agents API 用法参考（`openai-agents==0.17.8` + `openai>=2.44,<2.45` 已知兼容 pin、Model 接口、SQLiteSession、trace processor、DeepSeek thinking 关闭）。artifacts 子系统在旧 Python 中不存在，需按 TS 设计新写。
- **HTTP 契约不变**：`/api/chatty/*` 的 JSON shape、状态码、422 detail 格式、CORS、OpenAPI surface 与 TS 版一致（该格式本就模仿 FastAPI，回归后由 FastAPI 原生产出）。契约的唯一权威从 `packages/contracts`（zod）移交给 Pydantic 模型 + OpenAPI；前端保留本地 zod 校验副本。
- **数据兼容**：SQLite schema、Session JSON（Python SDK 格式，TS 版当时特意保持兼容）、Knowledge JSONL、eval cases/results JSONL、本地 Trace 格式全部延续。
- **进程模型**：FastAPI 成为唯一 HTTP 进程（127.0.0.1:8000）。开发时 Vite dev server 将 `/api/chatty` 代理到 FastAPI；生产与 CI smoke 由 FastAPI 直接伺服 `apps/web/dist` 静态产物，保持单一 origin。禁止两个后端进程同时写同一 SQLite 文件。

## 迁移完成条件

`uv run ruff check`、`uv run ty check`、`uv run pytest`、确定性 eval、`pnpm lint`、`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm test:e2e` 全绿后，删除 `apps/api`、`packages/*` 与 Next.js 依赖，CI 同步重写。删除前 TS 实现保留在 git 历史（本 ADR 之前的最后 TS revision）作为回滚边界；回滚必须同时恢复同一时间点的 SQLite 备份。
