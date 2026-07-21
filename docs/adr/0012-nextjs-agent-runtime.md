# Next.js 作为唯一 HTTP 入口

- 状态：Accepted（2026-07-21）
- 取代：ADR 0010 中的 Fastify adapter 与独立 API 进程

Chatty 是一个全栈 TypeScript Agent MVP。Node.js 24 运行 Next.js、Agent/Harness 和 SQLite。Next.js 提供页面、HTTP Route Handler 和进程入口。`@chatty/agent` 包含 Agent、Runner、Tools、Session、Trace、验证和数据访问。

Next.js catch-all Route Handler 调用 `handle`。该函数接收 `Request` 并返回 `Response`。HTTP application 统一处理 `/api/chatty/*` 的 JSON、状态码、服务端身份、错误、OpenAPI、404、405 和 CORS。页面不包含这些逻辑。

独立 `:8001` 根路径 API 没有直接等价：它与同一 Next origin 的 `/orders` 页面冲突。本次迁移显式废弃独立端口和根 API，唯一 HTTP base 改为 `/api/chatty`；浏览器原有同源 contract 不变。

迁移检查点依次为：C1 双跑 Fastify 与 framework-neutral contract；C2 Next direct E2E、Fastify 默认；C3 Next direct 默认、Fastify 显式回退；C4 全部门禁通过后删除 Fastify、回退变量与独立启动器。C1-C3 的验证结果保留在迁移过程，主线最终只维护 C4。

回滚必须同时恢复代码与切换前 SQLite 备份。回滚时先停止 Next，再启动旧 Fastify revision，禁止两个进程同时写同一 SQLite 文件。
