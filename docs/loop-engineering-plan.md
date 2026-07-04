# Loop Engineering Plan

Last updated: 2026-07-04

## 0. Decision Snapshot

This plan starts the Next.js-first Chatty agent loop foundation without rewriting the current rental RAG service.

Stack and product decisions are registered once in
[tech-stack-decisions.md](tech-stack-decisions.md); this plan does not restate them.
This document keeps the migration plan, phase records, and the Legacy Migration Ledger (§16).

## 1. Scope And Non-Goals

### Scope

- Document the target MVP loop architecture.
- Add a minimal TypeScript package skeleton for shared contracts, SQLite schema, agent-core boundaries, and LLM adapters.
- Preserve existing `rag-service` behavior.
- Make the current RAG service build remain the compatibility check.

### Non-Goals

- No full Next.js UI migration yet.
- No rewrite of `rag-service/public/test.html`.
- No rewrite of `rag-service/dashboard`.（该子包已于 2026-07 删除：apps/web 的 `/dashboard` 重建了同类功能，源码在 git 历史 / `legacy-extras` 分支）
- No full memory redesign.
- No full Chatwoot inbox clone.
- No direct production dependency on Agent Builder exported flows.

## 3. Current System Baseline

Current service:

- `rag-service/src/server.ts` exposes Fastify routes and static pages.
- `rag-service/src/rag.ts` exports `answerQuestion()`.
- `rag-service/src/memory-store.ts` persists `CustomerMemory` and `ProductMemory` into `data/memory-store.json`.
- `rag-service/src/conversation-orchestrator.ts` derives the current business stage.
- `rag-service/src/rag/action-picker.ts` maps context into actions.
- `rag-service/public/test.html` is the manual test console.
- `rag-service/dashboard` was the legacy Vite dashboard source (removed 2026-07, superseded by apps/web `/dashboard`).

Important limitation:

- `answerQuestion()` returns an answer but does not write memory by itself.
- The Fastify `/chat` route calls `appendConversationMemory()` after `answerQuestion()`.
- The current `answerQuestion()` still runs RAG before action selection. The new loop must not treat that as the target lazy-context behavior.

## 4. Target MVP Architecture

> 注：图中 Agents SDK lane（AGENTS 节点）已于 2026-07 整体删除（见 §5.2 / §16），保留原图作规划记录。

```mermaid
flowchart TD
  USER["Customer / operator"] --> WEB["Next.js app"]
  WEB --> ROUTE["Next.js Route Handlers"]
  ROUTE --> LOOP["Chatty bounded loop"]
  LOOP --> CTX["lazy context builder"]
  CTX --> SQLITE["SQLite session/state"]
  CTX --> MEMORY["CustomerMemory/ProductMemory JSON columns"]
  CTX --> KNOW["knowledge/media retrieval adapters"]
  LOOP --> LLM["packages/llm"]
  LLM --> AGENTS["OpenAI Agents SDK TS"]
  LLM --> CHAT["OpenAI Chat Completions API"]
  LOOP --> TOOLS["runtime tools"]
  TOOLS --> ORDER["order/inventory/media/handoff adapters"]
  LOOP --> TRACE["agent trace"]
  TRACE --> SQLITE
  ROUTE -. "compatibility lane" .-> LEGACY["rag-service /chat or answerQuestion adapter"]
  LEGACY -. "unchanged" .-> OLDUI["test.html"]
```

## 5. Runtime Lanes

### 5.1 Production Lane: Next.js Route Handlers

Next.js Route Handlers are the MVP API surface:

- receive customer/admin messages;
- create or load `AgentSession`;
- call a bounded local agent step;
- persist trace and state;
- return response to the caller.

### 5.2 Model Lane: OpenAI Agents SDK TS

> **已删除（2026-07）**：该 lane（适配器、`CHATTY_AGENTS_SDK` 开关与 `@openai/agents` 依赖）
> 在零生产调用方的状态下整体移除（见 §16）。重新引入的前提是先有具体消费方。以下为原始规划：

Use OpenAI Agents SDK TypeScript when an agent run benefits from tools, handoffs, guardrails, tracing, or built-in loop semantics.

The product code depends on `packages/llm` interfaces, not SDK implementation details.

### 5.3 Compatibility Lane: Chat Completions API

Use direct Chat Completions for:

- legacy `rag-service` compatibility;
- intent classification;
- structured fact extraction;
- reply evaluation;
- fallback generation;
- low-level direct model calls where Agents SDK is unnecessary.

### 5.5 Legacy Reference Lane: rag-service

The current `rag-service` remains the migration source and compatibility service.

> **2026-07 更新**：answerQuestion 注入位（`LegacyRagServiceAdapter`）已随 loop-runner 删除；
> 现在唯一跨边界的集成是评估器（`apps/web/lib/legacy-adapter.ts` 的 `loadLegacyEvaluator`，
> in-process dynamic import legacy dist）。以下为原始规划：

The minimal adapter is:

```text
LegacyRagServiceAdapter.answer(input)
  -> legacy /chat HTTP call, or injected answerQuestion function
  -> mapped answer/action/intent/handoff/references result
```

Short-term safest integration is HTTP against legacy `/chat`, because that preserves existing sanitization, memory writing, and response shape.

### 5.6 Naming

Use Chatty for the customer-facing agent and trace identity:

- external name: `Chatty`
- primary agent name: `ChattyAgent`
- rental-commerce instance: `RentalChattyAgent`
- trace field value: `agent_name = 'chatty'`

Keep low-level packages generic, such as `packages/agent-core`, so the architecture does not depend on the brand name.

## 6. Data And Persistence

### 6.1 SQLite MVP Schema

Table definitions live in [tech-stack-decisions.md §6](tech-stack-decisions.md#6-session-and-memory)
(single registry; not duplicated here).

### 6.2 Current Session Status

> **2026-07 更新**：`agent_sessions` 已在 SQLite 落地（`packages/db`），playground 每轮
> load/create session 并回写 status。以下为 2026-06 决策时的基线：

There was no real session store at decision time.

Continuity then depended on:

- `customerId`;
- `productId`;
- `conversationId`;
- `data/memory-store.json`;
- `recentMessages` under `ProductMemory`.

### 6.3 Conservative Memory Migration

```mermaid
flowchart LR
  JSON["data/memory-store.json"] --> READ["JSON fallback reader"]
  READ --> MAP["CustomerMemory/ProductMemory mapper"]
  MAP --> SQLITE["SQLite JSON columns"]
  SQLITE --> ADAPTER["memory repository interface"]
  ADAPTER --> LOOP["agent loop"]
```

Migration rules:

- Keep `CustomerMemory` and `ProductMemory` shape as JSON columns first.
- Do not normalize all profile fields in MVP.
- Preserve the read-only JSON fallback（SQLite 写路径已常开，`CHATTY_SQLITE` 开关 2026-07 退役）.
- Do not let OpenAI Agents SDK session memory become the long-term business memory.

## 7. Agent Loop Contract

Minimum interfaces:

- `ConversationEvent`
- `AgentSession`
- `AgentStepResult`
- `AgentTrace`
- `RuntimeTool`
- `MemorySnapshot`

```mermaid
sequenceDiagram
  participant U as User
  participant N as Next.js Route Handler
  participant S as SQLite
  participant C as Context Builder
  participant A as Agent Core
  participant L as LLM Adapter
  participant T as Runtime Tool

  U->>N: message
  N->>S: load/create session
  N->>C: build lazy context
  C->>S: read memory snapshot
  C-->>N: context
  N->>A: run bounded step
  A->>L: optional Agents SDK / Chat Completions call
  A->>T: optional tool call
  T-->>A: tool result
  A-->>N: AgentStepResult
  N->>S: persist trace/state
  N-->>U: reply or handoff status
```

## 8. Loop State Model

> **实现状态（2026-07-04）**：当前代码只会产生 `active` / `waiting_for_user` /
> `waiting_for_human` 三个状态（customer-harness 的 `nextStatus`；原 loop-runner 与
> SDK 适配器已删除）；`waiting_for_tool` / `paused` / `failed` / `closed` 及对应事件
> （`tool_result`、`scheduled_followup_due` 等）是预留设计，TS 类型已定义但无 producer
> （对应的运行时 zod 镜像已随 2026-07 清理删除）。引入 tool-chaining / worker 时再实现。
> 下图为目标全集：

```mermaid
stateDiagram-v2
  [*] --> active
  active --> waiting_for_user: reply_and_wait
  active --> waiting_for_tool: tool_then_continue
  active --> waiting_for_human: handoff_and_wait
  active --> paused: schedule_and_wait
  active --> closed: close
  waiting_for_user --> active: user_message
  waiting_for_tool --> active: tool_result
  waiting_for_human --> active: human_agent_replied
  paused --> active: scheduled_followup_due
  active --> failed: unrecoverable_error
  failed --> active: retry
  closed --> [*]
```

## 9. Tools, Playbooks, Policies, And Actions

Runtime vocabulary:

```mermaid
flowchart TD
  RUNTIME["Runtime customer-service system"] --> TOOLS["tools: executable capabilities"]
  RUNTIME --> PLAYBOOKS["playbooks: business flows（词汇预留，模块随 2026-07 简化移除）"]
  RUNTIME --> POLICIES["policies: approval/escalation/safety"]
  RUNTIME --> ACTIONS["actions: reply or control decisions"]
  RUNTIME --> KNOW["knowledge: FAQ/product/policy/media"]
  DEV["Development workflow"] --> DEVSKILLS["dev skills（项目级文件已于 2026-07 移除，惯例见 tech-stack §5）"]
```

Do not use `skills` for runtime concepts.

## 10. Evaluation And Regression Loop

```mermaid
sequenceDiagram
  participant A as Agent Reply
  participant T as Trace Store
  participant E as Evaluator
  participant F as Failure Case
  participant G as Golden Tests
  participant P as Policy/Playbook Patch

  A->>T: persist trace
  T->>E: evaluate latest reply
  E->>F: create low-score candidate
  F->>G: promote reviewed case
  G->>P: guide policy/prompt patch
```

MVP should preserve the current evaluator direction but make traces first-class.

## 11. Migration Strategy

### Phase 0: Foundation ✅（commit 373c11d）

- Add docs.
- Add shared contracts.
- Add SQLite schema SQL.
- Add agent-core and llm adapter interfaces.
- Keep `rag-service` unchanged.

### Phase 1: Next.js Shell ✅（commit 373c11d / 3f304c5）

- Add `apps/web` with App Router.
- Add simple health and playground routes.
- Link existing `rag-service` test page/dashboard rather than rewriting them.

### Phase 2: SQLite Adapter ✅（CHATTY_SQLITE 开关，commit b464c18；开关已于 2026-07 退役，SQLite 常开）

- Add SQLite connection and repository.
- Add JSON fallback reader from `rag-service/data/memory-store.json`.
- Add feature flag for SQLite write path.

### Phase 3: Agent Loop v0 ✅（commit 373c11d，legacy adapter 为 in-process 注入）

- Implement bounded step runner.
- Use `LegacyRagServiceAdapter.answer()` as the first answer path.
- Persist `AgentTrace`.

### Phase 4: Model Lanes ✅（CHATTY_AGENTS_SDK 开关仅路由 ask_info，commit 4e3a5bc；该 lane 已于 2026-07 整体删除，见 §16）

- Wire OpenAI Agents SDK TS runner.
- Keep Chat Completions direct adapter for extraction/eval/fallback.
- Route only selected actions through Agents SDK.

## 12. Open Questions

Open:

- When should Route Handlers be split into a separate worker or API service?
- When should Qdrant be retained vs wrapped behind a media/knowledge adapter?
- PRD §8.1 的 durable ConversationEvent 表：当前只持久化 trace，事件对象用后即弃。
  M2 的这条承诺显式推迟——单机 MVP 里 trace 已够回放；引入 worker/重试语义时再建表。

Settled:

- SQLite connection lives in `packages/db` (`database.ts`), repositories are factories over it.
- Legacy 集成走 in-process 而非 HTTP：`apps/web/lib/legacy-adapter.ts` dynamic-import
  rag-service dist（Next 标记其为 server external）。2026-07 起该边界只剩评估器
  （`loadLegacyEvaluator`）——answerQuestion 注入位已随 loop-runner 删除。
- ~~Agents SDK routes only `ask_info` (feature flag `CHATTY_AGENTS_SDK=1`)~~ 2026-07 更新：
  Agents SDK lane 已整体删除（零生产调用方），全部走 direct Chat Completions。
- Stack-level decisions (Next.js first, SQLite, no Fastify, Temporal deferred,
  Chatwoot as reference, runtime concepts are not called skills): see
  [tech-stack-decisions.md](tech-stack-decisions.md).

## 13. Implementation Plan

1. Keep `rag-service` build passing.
2. Add root workspace files without changing `rag-service` behavior.
3. Add `packages/shared` for DTOs and zod schemas.
4. Add `packages/db` for SQLite schema SQL only.
5. Add `packages/agent-core` for loop contracts and legacy adapter boundary.
6. Add `packages/llm` for OpenAI Agents SDK and Chat Completions adapter boundaries.
7. Typecheck new packages.
8. Build `rag-service`.
9. Add Next.js app only after the package contracts are stable.

## 14. Acceptance Criteria

- `docs/loop-engineering-plan.md` exists and matches latest decisions.
- The root workspace has no effect on existing `rag-service` runtime behavior.
- `packages/shared` defines minimal loop DTOs.
- `packages/db` defines SQLite MVP schema.
- `packages/agent-core` defines loop and legacy adapter boundaries.
- `packages/llm` defines the Chat Completions adapter boundary（Agents SDK 边界已于 2026-07 删除）.
- `pnpm build:rag-service` still passes or its existing failures are documented.

## 16. Legacy Migration Ledger

「保持好 specs/test/interface，随时可重写」的进度账本。五项 legacy 能力的接管状态：

| 能力 | 边界接口 | 状态 | 下一步 |
|---|---|---|---|
| 回答路径 answerQuestion | compose 步的 `CustomerServiceModelFn`（playground route 注入 Chat Completions adapter） | 🟡 部分接线——`CHATTY_LLM=1` 且配置 `OPENAI_API_KEY` 时 compose 走真 LLM，未开启或模型调用失败回退确定性 `createCustomerServiceModelOutput`；知识检索已由 agentic search（harness lane 的 `search_knowledge` + FTS）承担。旧 loop-runner / Agents SDK lane（含 `LegacyRagService` 注入位与 `@openai/agents` 依赖）已整体删除 | 拿金标场景对齐后替换 legacy answerQuestion（属 R5，前置=下方红/黄项闭环） |
| 评估器 LLM-judge | `Evaluator`（`evaluateCustomerServiceReply`，eval.ts 同步调用回填分数） | 🟢 保留为朴素金标回归的 judge：`pnpm eval --target harness` 内由 runner 同步调 judge 回填每场景分数。曾有的评测飞轮（playground trace fire-and-forget 自动评分 → `trace_reviews` → 低分晋升 failure_case → promote CLI → golden 回归）已于 2026-07 整体退役（过度设计，dont overdo）：`eval-chain.ts`、`promote-failure-case.mts`、`golden-export`、`failure-case`/`trace-review` 仓与表、`findUnevaluated` 均删 | judge 交叉复评（如需） |
| 知识检索 searchKnowledge | agentic search（`search_knowledge` 工具 + FTS5 索引） | 🟢 R4 已执行（2026-07）：legacy 的 embedding/qdrant 检索子系统（qdrant client、embedding 调用、`ingest.ts`、`chunking.ts`、local-vectors）整体删除；agentic search 上线为当前检索路径。legacy `answerQuestion` 内的检索早因 embeddings 404 恒空，删除只是把"404 降级"变成结构上不存在，行为不变 | 无（子系统退役完成） |
| 会话记忆 | `MemoryRepository`（SQLite + JSON 只读回退） | 🟡 新 loop 仅持久化 recentMessages（写 SQLite，JSON 保持只读回退）；profile 字段仍只在 legacy 自身运行时写 JSON | profile 写路径迁 SQLite JSON 列 |
| 事实抽取 + 阶段状态机 | 无边界（legacy 内部） | 🔴 完全在 legacy（extractStructuredConversationFacts + orchestrator） | 状态机已有 22 个单测钉行为，可安全搬迁 |

已知缺口（测试钉住待修）：`post_order_followup` stage 在 `decideStage` 中不可达，
`close_loop` 动作是死代码——修复属于行为变更，需跑金标 eval 验证后再动。

### R4 退役记录（2026-07）

`agentic-search-design.md §6` 的 R4（删检索子系统）已执行，单独一个 commit：
qdrant client、embedding 调用、`ingest.ts`、`chunking.ts`、local-vectors、
`rag.ts` 内的 `searchKnowledge`/`embedText` 调用点、`@qdrant/js-client-rest` 依赖全部删除。
同批把过度设计的"评测飞轮"（trace 自动评分 → failure_case → golden 自动晋升）拆回
朴素金标回归（`pnpm eval --target harness` + 同步 judge）。

**平价状态（如实记录）**：harness lane 金标最好一轮 13/14（`tests/reports/harness-r*.json`），
未追到设计里写的 11/11（那是 legacy 场景集口径）门槛。用户决策**覆盖**了"平价才准删"的
硬门槛——RAG 直接退役，不因 13/14 未达标而阻塞（这是求职作品集项目，dont overdo，见好就收）。

双目标 runner 仍在（`--target harness` 为默认，`--target legacy` 作对照）；eval.ts 的被测面
已抽象为可切换目标，harness 场景在 `tests/golden-harness/`（14 个），legacy 场景在 `tests/golden/`。
