# Chatty Harness Design Map

Last updated: 2026-07-05

本文是 Chatty 的 agent 架构设计主文档。目标不是把参考仓所有能力搬进来，而是把 18 个关键问题逐个定清楚：

- 每个问题只选一个主参考实现：OpenClaw / Codex / Claude Code 三选一。
- Chatty 只取能服务租衣客服 harness 的最小子集。
- 改动 harness、tool、memory、parser、executor、eval 时，必须同步更新本文和
  `packages/shared/src/architecture-bounds.ts`。

补充图集见 [current-architecture.md](current-architecture.md)。

## 0. 总览

Chatty 的下限是 `docs/jd.md + PRD.pdf`。上限是本地源码：

- `/Users/edward/Documents/oss/openclaw`
- `/Users/edward/Documents/oss/codex`
- `/Users/edward/Documents/oss/claude-code`

Chatty 的位置在中间：保留 agent harness 的骨架，拒绝通用 coding agent 的能力面。

删除优先级高于优化：

- 低于下限：如果能力不足以支撑 `docs/jd.md + PRD.pdf`，补到下限。
- 区间内：保留最小实现，并用测试锁住行为。
- 超出上限或偏离客服 harness：先删除，不做优化、不做抽象、不留半成品。
- 重新引入越界能力前，必须先改 `packages/shared/src/architecture-bounds.ts` 和对应测试。

```mermaid
flowchart LR
  Lower["下限<br/>jd.md + PRD.pdf"] --> Chatty["Chatty<br/>customer-service harness"]
  Upper["上限<br/>OpenClaw / Codex / Claude Code"] --> Chatty

  Chatty --> Keep["保留<br/>loop / tool / context / parser / executor / memory / eval / trace"]
  Chatty --> Cut["不做<br/>terminal / 任意 file I/O / MCP runtime / multi-agent worker / vector DB"]
```

主链路只看这一张图：

```mermaid
flowchart LR
  User["用户消息"] --> Session["session + memory"]
  Session --> Scheduler["Q01 task scheduling"]
  Scheduler --> Context["Q06 input/context"]
  Context --> Loop["Q03 loop"]
  Loop --> Search["search_knowledge<br/>最多 3 次"]
  Search --> Context
  Loop --> Parser["Q10 output parser"]
  Parser --> Executor["Q11 executor"]
  Executor --> Policy["policy gate<br/>low / medium / high"]
  Policy --> Trace["trace + memory patch"]
  Trace --> Eval["Q13 tests / smoke / eval"]
```

18 个问题在架构上的分组：

```mermaid
mindmap
  root((Chatty Agent Harness))
    核心功能
      Q01 task scheduling
      Q02 multi agent
      Q03 loop
      Q04 workflow control
      Q05 observability
      Q06 input prompt
      Q07 long-term memory
      Q08 skills plugins
      Q09 context compression
      Q10 output parser
      Q11 executor
      Q12 configurable MCP
      Q13 eval tests
    tool calling
      Q14 terminal execution
      Q15 sandbox
      Q16 background tasks
      Q17 terminal output
      Q18 file IO
```

## 1. 18 问矩阵

| # | 问题 | 主参考实现 | Chatty 当前选择 | 代码落点 |
|---|---|---|---|---|
| Q01 | task scheduling 拆分 | Codex | 单轮窄任务 scheduler | `scheduleCustomerServiceTask` |
| Q02 | 如何实现 multi agent | Codex | 当前不做；出现 worker/subagent runtime 先删 | `CustomerServiceTask` |
| Q03 | loop 和流程控制 | Codex | 每请求一次 bounded harness step | `runCustomerServiceHarnessStep` |
| Q04 | 如何更好控制整个 loop 和 workflow | Codex | 常量上限、失败回退、显式 trace，不上 durable workflow | `customer-harness.ts` |
| Q05 | 如何做可视化、可观测性与 terminal UI | Codex | 不做 terminal UI，做 trace inspector | `harnessTrace` / `apps/web` |
| Q06 | input 拼接 prompt | Codex | 结构化 context fragments | `buildCustomerServiceContext` |
| Q07 | 如何实现 long-term memory | OpenClaw | SQLite memory + 业务知识 search，不做 embedding RAG | `memory-repository.ts` |
| Q08 | 如何实现 skills 和 plugins | Claude Code | 不做 runtime plugin；出现 plugin runtime 先删 | `tools/registry.ts` |
| Q09 | 如何做好 context auto compression | Codex | 只做 recentMessages 滑窗，暂不 auto-compact | `memory-repository.ts` |
| Q10 | output parser | Codex | JSON action parser + 安全 fallback | `parseCustomerServiceOutput` |
| Q11 | 执行器 executor | Codex | action -> policy -> tool result | `executeCustomerServiceAction` |
| Q12 | 如何设计可以自由配置的 MCP | Claude Code | 只保留 tool contract；出现 MCP runtime 先删 | `ToolDefinition` |
| Q13 | 如何做好 eval 和自动化测试 | Codex | unit + smoke + manual golden eval | `quality-gates.ts` / `eval/` |
| Q14 | terminal 执行 | Codex | 不开放 terminal；出现 shell/exec tool 先删 | 无 |
| Q15 | 如何控制 sandbox 环境 | Codex | OS sandbox 降维成业务 policy gate | `policies/policy.ts` |
| Q16 | 如何管理 background tasks | Codex | 默认禁止后台 agent task；出现静默后台 loop 先删 | `pnpm eval` 显式触发 |
| Q17 | terminal 读 output | Codex | 不读 stdout/stderr，只读 tool result 和 trace | `toolCalls` |
| Q18 | 基本 file I/O（读、写、搜） | Claude Code | 不开放任意读写，只保留 `search_knowledge` | `search-knowledge.ts` |

参考实现分布：

```mermaid
pie title 18 questions by primary reference
  "Codex" : 14
  "Claude Code" : 3
  "OpenClaw" : 1
```

## 2. 核心功能

### Q01. task scheduling 拆分

参考实现：Codex。

Chatty 把一轮用户输入先收敛成一个窄任务：`collect_missing_info`、`answer_question`、
`check_availability`、`handoff`、`follow_up`。这让后面的 context、parser、executor 都围绕同一个任务运行。

```mermaid
flowchart LR
  U["utterance"] --> S["scheduleCustomerServiceTask"]
  S --> T["CustomerServiceTask"]
  T --> C["context"]
  T --> E["executor intent"]
```

### Q02. 如何实现 multi agent

参考实现：Codex。

Chatty 当前不实现 multi agent。Codex 的 manager/subagent 模式只作为上限参照，不进入当前实现。
如果代码里出现 worker/subagent runtime，而没有先更新复杂度契约和 eval，处理方式是删除。

```mermaid
flowchart TB
  Main["Chatty main harness"] --> Task["CustomerServiceTask"]
  Task -. "当前不实现" .-> Reviewer["subagent"]
  Task -. "当前不实现" .-> Evaluator["worker"]
  Task --> Now["当前：main harness 自己完成"]
```

### Q03. loop 和流程控制

参考实现：Codex。

Chatty 的 loop 是一次请求内的有界 harness step。模型最多触发 3 次 `search_knowledge`，失败回退确定性 composer，保证没有 LLM key 也能跑。

```mermaid
flowchart LR
  Context["context"] --> Model["compose"]
  Model --> Need{"need search?"}
  Need -->|"yes <= 3"| Search["search_knowledge"]
  Search --> Context
  Need -->|"no / cap"| Parser["parser"]
```

### Q04. 如何更好控制整个 loop 和 workflow

参考实现：Codex。

控制点只有四个：搜索上限、失败回退、trace 必出、显式 eval。Chatty 不上 LangGraph、Temporal 或长期 workflow，因为 MVP 是每请求一次有界步。

```mermaid
flowchart TD
  Loop["bounded loop"] --> Cap["search cap"]
  Loop --> Fallback["deterministic fallback"]
  Loop --> Trace["trace required"]
  Loop --> Eval["eval when model behavior changes"]
```

### Q05. 如何做可视化、可观测性与 terminal UI

参考实现：Codex。

Chatty 不做 terminal UI。可视化对象是客服 turn：task、context、toolCalls、action、policy result、memoryPatch。

```mermaid
flowchart LR
  Trace["harnessTrace"] --> Task["task"]
  Trace --> Context["context fragments"]
  Trace --> Tools["tool calls"]
  Trace --> Action["parsed action"]
  Trace --> Policy["policy result"]
  Trace --> Memory["memory patch"]
```

### Q06. input 拼接 prompt

参考实现：Codex。

Prompt 不在 route 里手写大段字符串，而是由结构化 context fragments 组成：task、user、memory、product、knowledge。

```mermaid
flowchart LR
  Task["task"] --> Prompt["prompt/messages"]
  User["user message"] --> Prompt
  Memory["memory"] --> Prompt
  Product["product"] --> Prompt
  Knowledge["knowledge"] --> Prompt
```

### Q07. 如何实现 long-term memory

参考实现：OpenClaw。

OpenClaw 的主线是 `memory_search` 和 hybrid retrieval。Chatty 只取“长期状态可被检索并回填 prompt”这一层：SQLite memory snapshot + `search_knowledge`，暂不做 embedding/vector RAG。

```mermaid
flowchart LR
  SQLite["SQLite memory"] --> Context["context"]
  Knowledge["knowledge/"] --> Index["FTS5 + LIKE"]
  Index --> Tool["search_knowledge"]
  Tool --> Context
```

### Q08. 如何实现 skills 和 plugins

参考实现：Claude Code。

Claude Code 的价值在能力目录化：tools、MCP、hooks、skills、memory、permission 都能声明。
Chatty 当前只落到 typed tool registry。plugin runtime 属于越界能力，出现实现先删。

```mermaid
flowchart LR
  Idea["new capability"] --> Tool["typed tool"]
  Tool --> Schema["schema"]
  Tool --> Risk["risk"]
  Tool --> Policy["policy"]
  Tool --> Tests["tests"]
  Tool --> Trace["trace"]
```

### Q09. 如何做好 context auto compression

参考实现：Codex。

Codex 用 auto-compact 处理长任务。Chatty 当前会话短，先用 recentMessages 滑窗；只有 eval 证明丢上下文，才加 fragment 级摘要。

```mermaid
flowchart LR
  Messages["recent messages"] --> Window["sliding window"]
  Window --> Context["context"]
  Context -. "未来" .-> Summary["fragment summary"]
```

### Q10. output parser

参考实现：Codex。

模型输出必须变成 `CustomerServiceAction`。解析失败不能进入 executor，只能走安全 fallback。

```mermaid
flowchart LR
  Text["model output"] --> Parser["parseCustomerServiceOutput"]
  Parser -->|"ok"| Action["CustomerServiceAction"]
  Parser -->|"fail"| Fallback["safe answer"]
```

### Q11. 执行器 executor

参考实现：Codex。

Executor 是副作用边界。模型不能直接执行业务动作，必须经过 action、registry、policy。

```mermaid
flowchart LR
  Action["CustomerServiceAction"] --> Registry["tool registry"]
  Registry --> Policy["policy"]
  Policy -->|"allow"| Run["execute"]
  Policy -->|"approval"| Handoff["handoff"]
  Policy -->|"deny"| Deny["deny"]
```

### Q12. 如何设计可以自由配置的 MCP

参考实现：Claude Code。

Chatty 当前不接 MCP runtime。只保留 tool contract：name、description、parameters、risk、execute、policy。
MCP runtime 属于越界能力，出现实现先删。

```mermaid
flowchart LR
  MCP["future MCP tool"] -. "adapter" .-> Tool["internal typed tool"]
  Tool --> Policy["policy gate"]
  Policy --> Executor["executor"]
```

### Q13. 如何做好 eval 和自动化测试

参考实现：Codex。

测试是 architecture 的一部分。确定性逻辑进 unit，跨包行为进 integration，无网络主链路进 smoke，真实模型行为进 manual golden eval。

```mermaid
flowchart LR
  Change["behavior change"] --> Unit["unit tests"]
  Change --> Integration["integration tests"]
  Change --> Smoke["pnpm smoke"]
  Change --> Eval["pnpm eval"]
  Unit --> CI["CI gates"]
  Integration --> CI
  Smoke --> CI
```

## 3. tool calling

### Q14. terminal 执行

参考实现：Codex。

Chatty 不开放 terminal。客服 agent 的风险面是业务动作，不是 shell。

```mermaid
flowchart LR
  Chatty["Chatty agent"] -. "no bash" .-> Terminal["terminal"]
  Chatty --> Tools["business tools"]
```

### Q15. 如何控制 sandbox 环境

参考实现：Codex。

Codex 的 OS sandbox 在 Chatty 里降维成业务 policy gate：low 自动执行，medium 转审批，高风险永不自动执行。

```mermaid
flowchart TD
  Tool["tool call"] --> Risk{"risk"}
  Risk -->|"low"| Allow["auto execute"]
  Risk -->|"medium"| Approval["require approval"]
  Risk -->|"high"| Deny["deny"]
  Risk -->|"closed session"| Deny
```

### Q16. 如何管理 background tasks

参考实现：Codex。

默认禁止后台 agent task。允许的后台工作必须显式触发、幂等、可重放、有 trace。
静默后台 loop 属于越界能力，出现实现先删。

```mermaid
flowchart LR
  Agent["agent loop"] -->|"forbidden"| Silent["silent background task"]
  Manual["manual command"] --> Eval["eval / sync / follow-up"]
  Eval --> Trace["recorded state"]
```

### Q17. terminal 读 output

参考实现：Codex。

Chatty 不解析 stdout/stderr。可观测输出只有 model output、tool result、trace。

```mermaid
flowchart LR
  Model["model output"] --> Parser["parser"]
  Tool["tool result"] --> Trace["trace"]
  Trace --> UI["inspector"]
```

### Q18. 基本 file I/O（读、写、搜）

参考实现：Claude Code。

Claude Code 的 FileRead / FileWrite / Grep / Glob 是上限。Chatty 不开放任意读写，只保留业务知识搜索和 repository 读写。

```mermaid
flowchart LR
  FileIO["generic file I/O"] -. "not exposed" .-> Chatty["Chatty"]
  Knowledge["knowledge corpus"] --> Search["search_knowledge"]
  Repo["typed repositories"] --> State["session / memory / trace"]
```

## 4. 当前代码结构

```mermaid
flowchart TD
  Web["apps/web<br/>adapter + inspector"] --> Core["packages/agent-core<br/>harness"]
  Core --> DB["packages/db<br/>SQLite repositories"]
  Core --> LLM["packages/llm<br/>Chat Completions adapter"]
  Core --> Shared["packages/shared<br/>types / gates"]
  Core --> Tools["tools registry"]
  DB --> Knowledge["knowledge/ corpus"]
  Eval["eval/ golden regression"] --> Core
```

阅读顺序：

1. `packages/agent-core/src/customer-harness.ts`
2. `packages/agent-core/src/tools/registry.ts`
3. `packages/agent-core/src/policies/policy.ts`
4. `packages/db/src/memory-repository.ts`
5. `packages/shared/src/architecture-bounds.ts`

## 5. 设计原则

```mermaid
flowchart LR
  Need["业务需要"] --> Test["能否自动验证"]
  Test -->|"能"| Gate["加测试/CI/eval"]
  Test -->|"不能"| Risk["写明风险"]
  Gate --> Small["选最小实现"]
  Risk --> Small
  Small --> Contract["更新 architecture-bounds + 本文"]
```

核心原则：每个问题只选一个主参考实现；只借鉴 harness 结构，不复制参考仓的完整能力面。
删除比优化重要：任何低于下限或超出上限的实现，都先按边界处理，而不是就地美化。
