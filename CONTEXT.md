# Chatty 项目上下文

本文件是仓库唯一的架构与领域入口。Chatty 的后端是 Python/FastAPI 项目，使用 Python OpenAI Agents SDK 和 SQLite，用 uv 管理。前端是 Vite + React SPA，shadcn/ui 与 Tailwind CSS v4 只负责界面。

## 最高层边界

**Agent = Model + Harness**。

- Model 理解自然语言，并选择 Tool 和参数。
- Harness 提供服务端身份，限制 Tool 和 turn 数，执行操作并保存结果。
- Harness 重新读取 SQLite 数据，以验证任务是否完成。
- Artifact 状态、delivery receipt 或 Handoff receipt 必须已经保存并通过检查，才能作为完成证据。
- Harness 不使用关键词提前选择业务路径。

## 模块

- `main.py`：uvicorn 启动入口薄壳。装配逻辑在 `src/chatty/server.py`。
- `src/chatty/server.py`：唯一 uvicorn 入口工厂。`pnpm dev:api`、CI 冒烟与生产共用它，单进程伺服前端 `dist` 与 `/api/chatty/*`。
- `src/chatty/config.py`：运行时配置解析。仓库根、数据库路径、静态目录与 knowledge 路径只有这一个来源；空环境变量等同未设置，相对路径按仓库根解析。
- `src/chatty/env.py`：加载仓库根 `.env`。只做 setdefault，已存在的环境变量优先。
- `src/chatty/app.py`：FastAPI 应用工厂。全部路由挂在 `/api/chatty` 前缀下，可选伺服前端 `dist`。RunFailure 到 HTTP 状态的映射也在这里，路由级差异由调用点传入。
- `src/chatty/run.py`：唯一 Agent Loop。它使用 Python OpenAI Agents SDK 的 `Agent` 和 `Runner`。
- `src/chatty/agent.py`：Agent 构造和 live Model Provider（DeepSeek，Chat Completions 协议）。
- `src/chatty/harness.py` 与 `tools.py`：Tool 执行、权限边界、完成验证和 Handoff。每个 Tool 的参数 schema 只声明一次，两条校验 lane 由测试锁定一致（见 ADR 0015）。
- `src/chatty/session.py`：会话历史。表名、SDK `SQLiteSession` 生命周期与会话归属校验都在这里。读路径不依赖模型配置。
- `src/chatty/artifacts.py`：Research Artifact、Content Artifact、人工批准和 sandbox delivery receipt。
- `src/chatty/sqlite.py`：`Database` 连接句柄。它持有自己的写锁并提供 `transaction()`，调用方不需要知道锁从哪里来。
- `src/chatty/memory.py`、`support.py`、`traces.py` 与 `commerce.py`：按领域拆分的 store（客户记忆与会话归属、人工接管请求、本地 trace/span、订单）。Orders 相关代码暂时用于兼容。
- `src/chatty/runtime.py`：把上述 store 组装成一个进程内 runtime。它持有共享连接拓扑与关闭顺序。
- `src/chatty/knowledge.py`：从 JSONL 导入的 FTS5 Knowledge。
- `src/chatty/contracts.py`：Pydantic 契约。它是 HTTP JSON 契约的唯一权威；前端在 `web/src/lib/contracts.ts` 保留本地 zod 校验副本。
- `src/chatty/tracing.py`：SDK trace 落到本地 SQLite。
- `src/chatty/eval.py`：确定性 eval（`uv run python -m chatty.eval`）。
- `src/chatty/browser_smoke.py`：Playwright e2e 用的 ASGI 工厂，装配确定性脚本模型。
- `src/chatty/backup.py`：SQLite 在线备份 CLI。
- `web`：Vite SPA。它只负责界面，不含第二套业务逻辑。

## 运行时与进程模型

- Python 侧用 uv 工具链：`uv sync` 安装依赖，`uv run` 执行命令。
- 前端是 `web/` 下的独立 pnpm 单包项目（`pnpm -C web install --frozen-lockfile`），仓库不使用 pnpm workspace；根 `package.json` 只做脚本转发。
- FastAPI 是唯一 HTTP 进程（`127.0.0.1:8000`）。
- 开发时 Vite dev server（`127.0.0.1:3000`）把 `/api/chatty` 原样代理到 FastAPI，不改写前缀。
- 生产与 CI 冒烟由 FastAPI 直接伺服 `web/dist`（SPA fallback 到 `index.html`），保持单一 origin。
- 禁止两个后端进程同时写同一个 SQLite 文件。

## 产品能力与非目标

主流程包含五步：

1. 检索本地 Knowledge
2. 保存 Research Artifact
3. 根据 Research Artifact 保存 Content Artifact
4. 人工批准 Content Artifact
5. 导出到 sandbox，并保存 delivery receipt

外部 Skill 仓库只作为设计参考。Chatty 不加载第三方 Skill。它也没有 Skill catalog、workflow engine 或 Multi-Agent runtime。

小红书、抖音和公众号只是 Content Artifact 的格式。MVP 不连接真实媒体平台。它也不提供实时行情、投资建议、向量数据库或产业图数据库。

## 外部契约与兼容边界

旧 Orders、Memory 和 Handoff HTTP 接口暂时保持兼容。SQLite schema、Session JSON（Python SDK 格式）、Knowledge JSONL、eval JSONL 和本地 Trace 格式也保持兼容。

`/api/chatty/*` 的 JSON shape、状态码、CORS 和 OpenAPI surface 与 TypeScript 版一致。契约权威是 Pydantic 模型 + OpenAPI（见 ADR 0014）。

未知前端路径渲染 Workbench。旧客服 Tools、测试和数据仍用于兼容。删除前必须保留可验证的历史版本和回滚点。

Trace span 类型为 `agent`、`generation` 和 `function`。旧数据库中的历史 span 仍可查询。

配置来自 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL_ID` 和 `CHATTY_DATABASE_PATH`。CI 冒烟另用 `CHATTY_STATIC_DIR` 指定前端产物目录。Secret 不得进入响应、Trace、Session、SQLite 或日志。

## 运行与恢复

持续集成（CI）运行 `uv run ruff check .`、`uv run ty check`、`uv run pytest -q`、`uv run python -m chatty.eval`、前端 lint / 测试 / typecheck / build、单进程 FastAPI 冒烟（`chatty.server` 伺服 `web/dist`）和 `pnpm test:e2e`。根 pnpm scripts（`pnpm lint`、`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm eval`、`pnpm test:e2e`）委托同样的命令。`pnpm test:deepseek` 手动测试真实 DeepSeek 服务。

每次部署前运行 `uv run python -m chatty.backup --output <备份路径>`（默认 `--database data/chatty.sqlite`）。部署环境必须提供 Python runtime 和持久化磁盘。

回滚边界是删除 TypeScript 实现前的最后一个 TS revision（`991c111d41db96eae4e4ac4e5ee65f385829fb39`，见 ADR 0014）。回滚到该版本时，也要恢复同一时间点的 SQLite 备份。不要让两个版本同时写入一个数据库。
