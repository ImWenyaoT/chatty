# Chatty

[English](README.en.md)

Chatty 是一个全栈 TypeScript 项目。它演示一个可验证的单 Agent 研究与内容生产流程。

项目遵循 **Agent = Model + Harness**。Model 理解任务并选择 Tool。Harness 管理身份、权限、执行、数据保存和完成验证。模型回复不能单独证明任务已经完成。

## 技术栈

- **运行环境**：Node.js 24 和 pnpm workspace
- **Web**：Next.js App Router、React、shadcn/ui 和 Tailwind CSS v4
- **Agent**：TypeScript OpenAI Agents SDK
- **数据**：SQLite、FTS5 和 JSONL
- **契约**：TypeScript strict mode 和 Zod

Next.js 同时提供页面和 HTTP 入口。`apps/web` 的 Route Handler 直接调用 `@chatty/agent`。项目没有单独运行的 API 服务，也没有第二套业务逻辑。

`@chatty/agent` 包含 Agent、Harness、Tools、Session、Trace 和 SQLite 数据访问。`@chatty/contracts` 保存 Web 与 Agent 共用的 JSON 契约。

主流程为：检索本地 Knowledge，生成 Research Artifact，生成 Content Artifact，人工批准，然后导出到 sandbox。小红书、抖音和公众号只是内容格式。项目不会连接这些平台。

## 本地运行

需要 Node.js 24 和 pnpm 11。复用仓库现有 `.env` 中的 `OPENAI_API_KEY`。也可以设置 `OPENAI_BASE_URL` 和 `MODEL_ID`。不要把 key 提交到 Git。

```bash
pnpm install --frozen-lockfile
pnpm --filter @chatty/agent demo
pnpm dev
```

- Web：[http://127.0.0.1:3000/workbench](http://127.0.0.1:3000/workbench)
- Agent API 文档：[http://127.0.0.1:3000/api/chatty/docs](http://127.0.0.1:3000/api/chatty/docs)
- 默认数据库：`data/chatty.sqlite`
- 使用 `CHATTY_DATABASE_PATH` 可以修改数据库路径

## 验证

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm eval
pnpm test:e2e
pnpm test:deepseek
```

`pnpm eval` 运行 7 个可重复的 Agent/Harness 用例。结果写入 `eval/results.jsonl`。其中一个用例覆盖从检索到 Research Artifact，再到 Content Artifact 的完整 Runner 路径。

`pnpm test:deepseek` 使用现有 key 测试真实模型服务。测试覆盖 Tool schema、Session、Trace、Knowledge 来源和缺少参数时的恢复。测试不会输出或保存 key。

`pnpm --filter @chatty/agent test:resume-contract` 单独检查旧客服行为契约和对应 eval，避免演示方向升级后改变简历叙事。

## 构建、部署与恢复

```bash
pnpm build
CHATTY_DATABASE_PATH=/absolute/path/chatty.sqlite pnpm --filter @chatty/web start
```

生产入口是 Next.js 的 `next start`。仓库不依赖特定云平台。部署环境必须支持 Node.js 和持久化磁盘。SQLite 文件不能放在临时文件系统中。

切换版本前先备份数据库：

```bash
pnpm --filter @chatty/agent backup --database ../../data/chatty.sqlite --output ../../backups/chatty.sqlite
```

恢复时先停止 Next.js 进程。保留故障数据库，再恢复已验证的备份。启动后检查健康接口。

迁移前的代码版本是 `1c350fc382119c52431e1f050b616e340c1df026`。回滚到该版本时，也要恢复同一时间点的 SQLite 备份。不要让不同版本同时写入一个数据库。

旧 Web 页面会重定向到 Workbench。旧 Orders API、Tools、测试和 SQLite 表仍用于兼容与回滚。删除前必须保留可验证的历史版本和回滚点。

这是本地 MVP。它不提供生产级多租户、水平扩展、真实平台分发、Skill runtime、workflow engine 或 Multi-Agent runtime。
