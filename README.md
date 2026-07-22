# Chatty

[English](README.en.md)

Chatty 是一个 Python/FastAPI 后端加 Vite/React 前端的项目。它演示一个可验证的单 Agent 研究与内容生产流程。

项目遵循 **Agent = Model + Harness**。Model 理解任务并选择 Tool。Harness 管理身份、权限、执行、数据保存和完成验证。模型回复不能单独证明任务已经完成。

## 技术栈

- **后端**：Python 3.12、FastAPI、uv 工具链
- **Agent**：Python OpenAI Agents SDK
- **前端**：Vite、React、shadcn/ui 和 Tailwind CSS v4
- **数据**：SQLite、FTS5 和 JSONL
- **契约**：Pydantic 模型 + OpenAPI；前端保留本地 zod 校验副本

FastAPI 是唯一 HTTP 进程，提供 `/api/chatty` 全部接口。`src/chatty` 包含 Agent、Harness、Tools、Artifacts、Session、Trace 和 SQLite 数据访问。`apps/web` 是 Vite SPA，只负责界面，没有第二套业务逻辑。

主流程为：检索本地 Knowledge，生成 Research Artifact，生成 Content Artifact，人工批准，然后导出到 sandbox。小红书、抖音和公众号只是内容格式。项目不会连接这些平台。

## 本地运行

需要 uv、Node.js 24 和 pnpm 11。复用仓库现有 `.env` 中的 `OPENAI_API_KEY`：`pnpm dev:api` 和冒烟入口启动时会自动读取仓库根 `.env`（已存在的环境变量优先，生产环境仍可直接导出真实变量）。也可以设置 `OPENAI_BASE_URL` 和 `MODEL_ID`。不要把 key 提交到 Git。

```bash
uv sync
pnpm install --frozen-lockfile
pnpm dev:api   # FastAPI，127.0.0.1:8000
pnpm dev       # Vite dev server，127.0.0.1:3000，代理 /api/chatty 到 FastAPI
```

- Web：[http://127.0.0.1:3000/workbench](http://127.0.0.1:3000/workbench)
- Agent API 文档：[http://127.0.0.1:8000/api/chatty/docs](http://127.0.0.1:8000/api/chatty/docs)
- 默认数据库：`data/chatty.sqlite`
- 使用 `CHATTY_DATABASE_PATH` 可以修改数据库路径（相对路径按仓库根解析）

## 验证

```bash
pnpm lint        # uv run ruff check . + 前端 eslint/prettier
pnpm test        # uv run pytest -q + 前端契约测试
pnpm typecheck   # uv run ty check + tsc
pnpm build       # vite build
pnpm eval        # uv run python -m chatty.eval
pnpm test:e2e    # Playwright（自动拉起 FastAPI 冒烟后端和 Vite dev server）
pnpm test:deepseek
```

`pnpm eval` 运行 7 个可重复的 Agent/Harness 用例。结果写入 `eval/results.jsonl`。其中一个用例覆盖从检索到 Research Artifact，再到 Content Artifact 的完整 Runner 路径。

`pnpm test:deepseek` 使用现有 key 测试真实模型服务（`uv run pytest -m deepseek`，默认测试运行会跳过这些用例）。测试覆盖 Tool schema、Session、Trace、Knowledge 来源和缺少参数时的恢复。测试不会输出或保存 key。

## 构建、部署与恢复

```bash
pnpm build
CHATTY_DATABASE_PATH=/absolute/path/chatty.sqlite CHATTY_STATIC_DIR=apps/web/dist \
  uv run uvicorn --factory chatty.smoke:create_smoke_app --host 127.0.0.1 --port 8000
```

生产入口是单进程 FastAPI：同时伺服 `apps/web/dist` 和 `/api/chatty/*`，保持单一 origin。仓库不依赖特定云平台。部署环境必须支持 Python 和持久化磁盘。SQLite 文件不能放在临时文件系统中。

切换版本前先备份数据库：

```bash
uv run python -m chatty.backup --database data/chatty.sqlite --output backups/chatty.sqlite
```

恢复时先停止 FastAPI 进程。保留故障数据库，再恢复已验证的备份。启动后检查健康接口。

回滚边界是删除 TypeScript 实现前的最后一个 TS revision `991c111d41db96eae4e4ac4e5ee65f385829fb39`（见 ADR 0014）。回滚到该版本时，也要恢复同一时间点的 SQLite 备份。不要让不同版本同时写入一个数据库。

这是本地 MVP。它不提供生产级多租户、水平扩展、真实平台分发、Skill runtime、workflow engine 或 Multi-Agent runtime。
