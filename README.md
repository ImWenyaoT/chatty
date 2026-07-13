<p align="center"><strong>Chatty</strong></p>
<p align="center">
  <a href="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml/badge.svg" /></a>
</p>
<p align="center">简体中文 | <a href="README.en.md">English</a></p>

---

面向租赁电商客服场景的 **[agent][] [harness][]** · TypeScript / Node.js · DeepSeek 驱动。围绕一个问题——*一轮客服如何算完成、算做对*——把任务识别、[context][] 拼接、知识检索、tool use、风险审批与人工接管,设计成可评测、可复盘的闭环。[model][] 固定为 `deepseek-v4-pro`,[harness][] 才是可演进的部分。

- **任务终点 + 回归评测** — 从客服高频任务定义终点(回复 · 查知识 · 查库存 · 转人工 · 跟进);golden 场景 + LLM judge 做回归,把偏题回复、工具漏调、动作误判沉淀为固定测试集。
- **Agentic 检索,不做 RAG** — 政策/费用/租期/售后等事实走 `search_knowledge` [tool call][] over SQLite FTS5:top-3 命中、有界 tool loop、query 去重、证据回填 [context][] 做核验——无 RAG pipeline、无 vector database。
- **受限执行器** — 模型输出解析为受限 `CustomerServiceAction`,executor 统一经 tool registry 与 allow / require_approval / deny [permission][permission mode] gate;退款、转人工、会话关闭(中高风险)进入审批或人工路径。
- **闭环反馈** — 工具调用、审批路径与评测失败样本串成 *客服任务 → 失败归因 → prompt / 流程改动 → 回归验证*,让 agent 体验问题可追踪、可修正、可验证。

## 快速开始

```bash
pnpm install --frozen-lockfile
pnpm dev      # Next.js playground（apps/web）
pnpm test     # 全 workspace 单测
pnpm smoke    # 核心数据链路冒烟，无网络
pnpm eval     # 金标回归（需真实 DeepSeek key）
```

运行 playground 前配置 `OPENAI_API_KEY`(DeepSeek 的 OpenAI-format key),否则消息接口返回 503。状态默认持久化到 `data/chatty.sqlite`;改路径设 `CHATTY_DB_PATH`。

## Monorepo

`apps/web` 只做展示与 HTTP 适配,价值在 `agent-core` 这层 [harness][];[model][] 与持久化都是可替换的依赖。

```mermaid
flowchart TD
  web["apps/web · Next.js<br/>playground + dashboard + /api"]
  core["packages/agent-core · Harness<br/>确定性任务调度 · context 组装/压缩 · 有界 loop · run policy · 工具 · agentic 检索"]
  llm["packages/llm<br/>DeepSeek ⇄ OpenAI Agents SDK · usage 遥测"]
  db[("packages/db · SQLite<br/>session · trace · 事务级 memory · FTS5 知识索引")]
  shared["packages/shared · 契约 / schema / 浏览器安全类型"]
  worker["scripts/worker · 后台作业<br/>到期跟进 · 记忆抽取/固化"]
  eval["eval/ · 金标回归 + LLM judge"]
  deepseek(("DeepSeek API"))

  web --> core
  core --> llm --> deepseek
  core --> db
  worker --> core
  worker --> db
  eval --> core
  web -. 契约 .-> shared
  core -. 契约 .-> shared
```

| 路径 | 作用 |
| --- | --- |
| [`packages/agent-core`](packages/agent-core) | harness 核心:task scheduling、[context][]、run policy、tool execution、agentic search |
| [`packages/llm`](packages/llm) | DeepSeek 的 Agents SDK 适配 + usage 遥测([cache tokens][]、成本) |
| [`packages/db`](packages/db) | SQLite:[session][] / trace / [memory][memory system] / knowledge(FTS5) |
| [`packages/shared`](packages/shared) | 跨包类型、schema 与浏览器安全契约 |
| [`apps/web`](apps/web) | Next.js playground + dashboard |
| [`eval/`](eval) | 金标回归 + LLM judge |

## 质量门禁

`test` / `test:fullstack` / `test:coverage` / `test:coverage:core` / `smoke` / `typecheck` / `lint` 在每个 PR 与 `main` 上由 [CI](.github/workflows/ci.yml) 跑;full-stack 门覆盖真实 Next API、SQLite 与 worker 的联调。真实 LLM 的金标回归是手动 workflow([`eval.yml`](.github/workflows/eval.yml))。`v*` tag 会构建 standalone server、以持久 SQLite 路径做 `/api/health` 冒烟,并发布可运行的 [release](.github/workflows/release.yml)。命令以根 [`package.json`](package.json) 为真相源。

## 核心能力

一条消息 = 一个有界 [turn][]。[harness][] 掌控任务边界、[context][] 与工具,[model][] 只在被调度的 task 内决定下一步。

```mermaid
sequenceDiagram
  autonumber
  participant U as 客户消息
  participant H as Harness (agent-core)
  participant M as Model (DeepSeek·Agents SDK)
  participant T as Tools + Policy
  participant D as SQLite

  U->>H: 一条客服消息
  H->>H: 确定性任务调度（选 task + 工具子集）
  H->>D: 读 memory / checkpoint
  H->>H: context 组装（超限则压缩为 checkpoint）
  H->>M: 工具阶段 run（有界 turns）
  M->>T: 请求 search_knowledge
  T->>T: run policy 门：allow / require_approval / deny
  T->>D: FTS5 检索知识
  T-->>M: 证据（纯文本三段式）
  M-->>H: 工具结果
  H->>M: 无工具收尾 run（基于证据生成回复）
  M-->>H: 最终回复
  H->>D: 落 trace + 续接 memory + 更新 session
  H-->>U: 回复 + 可观测 harnessTrace
```

### task scheduling

harness(而非 model)在组装前就选定有界 task 与其工具子集(Claude-Code 式:每个 task 一个收窄的工具池 + 有界 turns)。

### loop 和流程控制

两个有界阶段:工具轮 → 基于证据的无工具收尾。缺 key、provider、输出校验失败都保持显式错误,绝不伪装成回复。

### input 拼接 prompt

[context][] 由 [memory][memory system] + 检索知识 + 上一个 checkpoint 拼成,超 [token][] 预算则 [compaction][] 成新 checkpoint。

### 执行器 executor

每次 [tool call][] 过 allow / require_approval / deny [permission][permission mode] 门——高风险工具(如退款)绝不自动执行。回复、trace 与续接 [memory][memory system] 在同一 [turn][] 内落 SQLite。

## tool calling

每个调度 task 只把所需工具作为 Agents SDK function [tool][] 暴露。`search_knowledge` 在 SQLite FTS5 上做 agentic 检索(即上图 5–9 步);`check_availability` / `create_handoff` / `schedule_followup` 覆盖其余。这里没有 [MCP][] 与 [skill][skill]——那是 multi-agent 姊妹项目的领域,不属于这个单 agent harness。

## 数据说明

本仓库开源,但业务源自真实店铺:真实客户信息与店铺隐私数据一律不入库,示例统一用占位符(示例租衣店 / 18800000000)。约定见 [AGENTS.md](AGENTS.md)。

## 许可

以 [MIT](LICENSE) 许可发布。

<!-- AI coding dictionary (https://www.aihero.dev/ai-coding-dictionary) —— 这些词保持英文并链接，不翻译。 -->
[agent]: https://www.aihero.dev/ai-coding-dictionary/agent
[harness]: https://www.aihero.dev/ai-coding-dictionary/harness
[model]: https://www.aihero.dev/ai-coding-dictionary/model
[context]: https://www.aihero.dev/ai-coding-dictionary/context
[memory system]: https://www.aihero.dev/ai-coding-dictionary/memory-system
[session]: https://www.aihero.dev/ai-coding-dictionary/session
[turn]: https://www.aihero.dev/ai-coding-dictionary/turn
[compaction]: https://www.aihero.dev/ai-coding-dictionary/compaction
[token]: https://www.aihero.dev/ai-coding-dictionary/token
[tool]: https://www.aihero.dev/ai-coding-dictionary/tool
[tool call]: https://www.aihero.dev/ai-coding-dictionary/tool-call
[permission mode]: https://www.aihero.dev/ai-coding-dictionary/permission-mode
[cache tokens]: https://www.aihero.dev/ai-coding-dictionary/cache-tokens
[MCP]: https://www.aihero.dev/ai-coding-dictionary/mcp
[skill]: https://www.aihero.dev/ai-coding-dictionary/skill
