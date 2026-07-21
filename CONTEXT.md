# Chatty 项目上下文

本文件是仓库唯一的架构与领域入口。Chatty 是一个全栈 TypeScript 项目。它运行在 Node.js 24 上，并使用 Next.js、OpenAI Agents SDK 和 SQLite。shadcn/ui 与 Tailwind CSS v4 只负责界面。

## 最高层边界

**Agent = Model + Harness**。

- Model 理解自然语言，并选择 Tool 和参数。
- Harness 提供服务端身份，限制 Tool 和 turn 数，执行操作并保存结果。
- Harness 重新读取 SQLite 数据，以验证任务是否完成。
- Artifact 状态、delivery receipt 或 Handoff receipt 必须已经保存并通过检查，才能作为完成证据。
- Harness 不使用关键词提前选择业务路径。

## 模块

- `apps/web`：Next.js 应用。它提供页面和 `/api/chatty` HTTP 入口。
- `apps/web/src/app/api/chatty/[...path]/route.ts`：直接调用 `@chatty/agent`。它不复制业务逻辑。
- `apps/api`：`@chatty/agent` 包的源码。它不是独立的网络服务。
- `apps/api/src/agent-runtime.ts`：唯一 Agent Loop。它使用 TypeScript OpenAI Agents SDK 的 `Agent` 和 `Runner`。
- `apps/api/src/harness.ts` 与 `tools.ts`：Tool 执行、权限边界、完成验证和 Handoff。
- `apps/api/src/artifacts.ts`：Research Artifact、Content Artifact、人工批准和 sandbox delivery receipt。
- `apps/api/src/runtime.ts`、`stores.ts` 与 `commerce.ts`：SQLite 数据访问。Orders 相关代码暂时用于兼容。
- `apps/api/src/session.ts`：SQLite Session。它可以读取迁移前保存的 JSON。
- `apps/api/src/knowledge.ts`：从 JSONL 导入的 FTS5 Knowledge。
- `packages/contracts`：Web 与 Agent 共用的 HTTP JSON 契约。

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

旧 Orders、Memory 和 Handoff HTTP 接口暂时保持兼容。SQLite schema、Session JSON、Knowledge JSONL、eval JSONL 和本地 Trace 格式也保持兼容。

`/playground`、`/orders` 和 `/dashboard` 会重定向到 `/workbench`。旧客服 Tools、测试和数据仍用于兼容。删除前必须保留可验证的历史版本和回滚点。

新的 Trace span 类型为 `agent`、`generation` 和 `function`。旧数据库中的历史 span 仍可查询。

配置来自 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL_ID` 和 `CHATTY_DATABASE_PATH`。Secret 不得进入响应、Trace、Session、SQLite 或日志。

## 运行与恢复

持续集成（CI）运行 `pnpm lint`、`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm eval`、构建产物检查和 `pnpm test:e2e`。`pnpm test:deepseek` 手动测试真实 DeepSeek 服务。

每次部署前运行 `pnpm --filter @chatty/agent backup`。部署环境必须提供 Node.js runtime 和持久化磁盘。

回滚到 `1c350fc382119c52431e1f050b616e340c1df026` 时，也要恢复同一时间点的 SQLite 备份。不要让两个版本同时写入一个数据库。
