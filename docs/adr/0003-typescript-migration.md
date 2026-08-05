---
status: accepted
supersedes: 0002-python-fastapi-agents-sdk
---

# 从 Python 迁移到 TypeScript 全栈

Chatty 原本是 Python 后端（FastAPI + uv + pytest + Pydantic + openai-agents-python）
加 TypeScript 前端。现在整个仓库统一为 TypeScript：`server/` 承担 Agent、Tool、Harness、
SQLite 与 HTTP，`frontend/` 保持 React + Vite 不变。

ADR 0002 中与技术栈无关的结论全部继续有效：Chatty 仍然是 Single Agent，五项能力仍然是
Tool，SQLite 仍然是商品、库存和知识检索的运行时事实源，配置优先级仍然是
`.env.local > .env > system environment`。本 ADR 只替换 ADR 0002 中关于语言与运行时的部分。

## 决策

- 运行方式是 `node` 直跑 `.ts`，没有构建步骤、没有 dist 目录。Node 从 22.18 起默认启用
  类型剥离，仓库要求 Node 24+，因此不需要 `--experimental-strip-types` flag。
  TypeScript 只做类型检查（`tsc --noEmit`），因此 `tsconfig.json` 打开 `erasableSyntaxOnly`，
  代码里不使用 enum、参数属性等需要代码生成的语法。
- HTTP 层用 Hono 替代 FastAPI，职责完全不变：校验、Session、错误码、Reply 序列化。
  Wire 格式保持 snake_case，前端代码零改动。
- Schema 用 zod 替代 Pydantic，同时作为 Agents SDK 的 tool parameters 与 structured output。
- 数据层用 Node 内置 `node:sqlite` 的 `DatabaseSync` 替代 `sqlite3`；FTS5、`unicode61`
  分词器与 `bm25()` 排序全部可用，检索行为不变。
- 测试用 Node 内置 `node:test` 替代 pytest；配置解析用 Node 内置 `util.parseEnv` 替代
  python-dotenv。除 Hono、zod、Agents SDK 外不引入额外运行时依赖。

## 为什么

单语言仓库消除了两套包管理器、两套 lint/format 工具链和两套 CI 依赖缓存。
更重要的是领域模型只需要定义一次：过去 Pydantic 模型和前端 TypeScript 类型是两份手写
定义，靠 review 保持同步；现在 `server/src/data/models.ts` 是唯一定义。

Node 的内置能力已经覆盖了原先需要第三方依赖的部分（SQLite、测试、类型剥离、env 解析），
所以这次迁移在减少语言的同时也减少了依赖数量。

## 迁移是如何被验证的

数据层是纯函数与纯 SQL，两种语言必须给出逐字节相同的结果。为此先建立
`tests/golden/` 跨语言基线：63 条 case 覆盖分词、切块、Query 改写、FTS 表达式构造、
画像、搜索、打分、库存、知识检索、营销策略、最终重查、TaskFrame 解析与批次裁决。
基线由 Python 实现生成并冻结，TypeScript 实现必须逐条匹配才算迁移完成。

这条基线抓住了若干不会自己暴露的差异：Python `round()` 是 banker's rounding 而
`Math.round()` 是 round-half-up；Python `len()` 按 code point 计数而 JS `String.length`
按 UTF-16 code unit 计数；Python 正则的 `\w` 默认匹配 Unicode 而 JS 的 `\w` 只匹配 ASCII。
三处都在 TypeScript 侧显式实现了 Python 语义。

## 两处必须重新设计的地方

### Tool 批次边界改用 `callModelInputFilter`

Python 版靠 `RunHooks.on_llm_end` 判断一批 Tool call 的开始。JS SDK 的 `RunHookEvents`
没有对应事件，只有 `agent_start`、`agent_end`、`agent_handoff`、`agent_tool_start`、
`agent_tool_end`。

改为用 `callModelInputFilter`：它在每次调用 Model 前触发，恰好等价于"上一批 Tool 已全部
结束"。批次内第一个 tool input guardrail 冻结 `{stage, allowed}` 快照，后续 guardrail 复用
同一快照并增量记录已接受的调用。配合 `maxFunctionToolConcurrency: 1`，裁决语义与 Python 版
完全一致。同一批裁决逻辑也是 golden 基线里 `plan_tool_batch` 的实现来源，只有一份真相。

### 测试注入 Model 而不是 patch Runner

Python 测试用 monkeypatch 替换 `Runner.run`，代价是 guardrail 和 input filter 都被绕过。

TypeScript 版引入 `ModelProvider` 接口（`{ agentModel, configured, modelId }`），
测试注入实现了 SDK `Model` 接口的 `ScriptedModel`，按脚本回放模型响应。请求走完整真实
Runner，因此阶段门禁、状态栏注入和 draft correction 都被真正执行到，而不是被跳过。

## 影响

- `backend/`、`pyproject.toml`、`uv.lock` 已删除，CI 不再安装 uv 与 Python。
- 根 `package.json` 的 `dev`/`start`/`test`/`typecheck`/`lint`/`eval:*` 全部指向 `server/`。
- 服务端口、HTTP 路径、错误码与 JSON 字段名保持不变，前端与 `.env.example` 无需改动。
