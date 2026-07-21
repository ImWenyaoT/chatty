# 增量迁移到 TypeScript runtime

- 状态：Accepted and completed（2026-07-20）
- 取代：ADR 0005 的 Python runtime 决定、ADR 0008 的单一 pnpm app 描述

Chatty 已通过兼容检查点迁移到单一 TypeScript runtime，而不是一次性重写。迁移期间始终保持 `Agent = Model + Harness`：Model 选择 Tool，Harness 约束执行并验证真实完成。

Fastify 只用于迁移检查点。迁移完成后的 HTTP 入口见 ADR 0012。

## 检查点结果

1. 建立 `packages/contracts` 与 Fastify adapter，锁定 HTTP JSON、状态码、CORS 与 OpenAPI surface。
2. 逐个迁移 SQLite Orders、Inventory、Memory、Handoff、Trace、Knowledge、demo seed，并用旧 schema fixtures 做双向兼容测试。
3. 迁移 Harness、严格 Tool 参数、业务 receipt、Knowledge 来源、Memory 来源、强制 Handoff 与 6/6 deterministic eval。
4. 接入官方 TypeScript OpenAI Agents SDK 的单一 `Agent + Runner`；DeepSeek 继续使用 OpenAI-compatible Chat Completions，thinking 显式关闭。
5. 迁移 SQLite Session 与本地 Trace processor；保留迁移前 Session JSON、Trace schema 与 Unicode case-fold 行为。
6. 以纯 TypeScript Playwright、真实 DeepSeek contract、SQLite backup/integrity drill、lint、type-check、test、build 和构建产物健康检查作为退出门禁，然后删除 Python runtime、proxy、fallback 配置与 Python CI。

## 无直接等价项

- Python `str.casefold()`：JavaScript 无标准库等价；使用固定依赖并排除 UCD 15.0 之后映射，完整 mapping hash 由测试锁定。
- 两种 Agents SDK 的 span taxonomy：新的运行记录使用 `agent/generation/function`；旧 SQLite 中的 `task/turn` 历史记录仍可读取，不伪造新 span。
- FastAPI/Pydantic validation：迁移阶段使用 Fastify/Zod。当前 Next.js Route Handler 调用同一个 HTTP application，并保留原有的 RunRequest 校验和 422 响应格式。

## 回滚与恢复

代码回滚边界为迁移前 revision `1c350fc382119c52431e1f050b616e340c1df026`。数据回滚使用切换前由 `pnpm --filter @chatty/agent backup` 生成并验证的 SQLite 快照。回滚必须同时匹配代码与数据库版本；迁移完成后不再在主线维护第二套 Python Agent Loop。
