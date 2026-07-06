# Tech Stack Decisions

Last updated: 2026-07-05

This document is the single decision registry for Chatty, the agentic customer-service rewrite. It supersedes the exploratory PRD (now a short decision record in `docs/archive/agentic-customer-service-prd.md`, full text in git history) where the two conflict.

## 1. Current Decision Summary

```text
Product/agent name: Chatty
Node.js + TypeScript
Next.js first
Customer-service Harness Core drives /api/playground
DeepSeek OpenAI-format Chat Completions through @openai/agents where supported
SQLite for MVP sessions/state
Existing memory model kept mostly intact
Temporal deferred until the product proves it needs durable workflow guarantees
Chatwoot used as open-source product reference, not as runtime dependency
No RAG / no vector database in the target architecture: memory + FTS indexing +
agent search tools; legacy qdrant retrieval subsystem retired 2026-07 (R4)
Quality gate: every automatically verifiable behavior must have automated verification
Complexity rule: delete out-of-bounds work before optimizing it
```

## 1.0 Complexity Boundary And Deletion Rule

Decision: Chatty must stay inside the interval defined by `docs/jd.md + PRD.pdf`
as the lower bound and local OpenClaw / Codex / Claude Code source trees as
the upper bound.

This is a deletion rule, not an optimization rule:

- Below the lower bound: add the missing harness behavior.
- Inside the interval: keep the smallest implementation that passes tests.
- Above the upper bound or unrelated to customer-service harness: delete first.
- Do not polish, abstract, or preserve out-of-bounds runtime code as future work.

The executable version lives in `packages/shared/src/architecture-bounds.ts`.

## 1.1 Agentic Coding Quality Gate

Decision: treat automated verification as product infrastructure, not cleanup.

In this repository, "done" means the relevant behavior is covered by the
cheapest reliable automated check:

- Pure deterministic logic: unit tests in the owning package.
- Cross-module behavior: lightweight integration tests that use real adapters
  where practical, especially for harness steps, policy, repositories, and
  `search_knowledge`.
- No-network production path: `pnpm smoke`.
- Type and build contracts: `pnpm typecheck`, `pnpm build:skeleton`, and
  `pnpm build`.
- Real model behavior: manual `pnpm eval` / `.github/workflows/eval.yml`,
  because it depends on secrets, external latency, and LLM judge noise.

The executable version of this contract lives in
`packages/shared/src/quality-gates.ts`, and
`packages/shared/src/quality-gates.test.ts` verifies that `package.json` and CI
still wire the required checks. If a future change adds, removes, or renames a
quality gate, update the contract and tests in the same change.

## 2. Next.js vs Fastify

Decision: use Next.js first. Do not add Fastify unless a concrete limitation appears.

Next.js can cover the initial Fastify role:

- Route Handlers for `/api/chat`, webhook-style callbacks, health checks, knowledge APIs, eval triggers, and admin BFF endpoints.
- Server Components for trace, memory, evaluation, and knowledge dashboard reads.
- Server Actions for internal admin mutations where browser forms are the caller.
- API routes or Route Handlers for file uploads and streaming where needed.

Fastify remains a later extraction option, not an MVP dependency.

Use Fastify later only if:

- We need a separately deployed high-throughput public API.
- Webhook handling needs independent scaling or stricter middleware control.
- Next.js route runtime becomes awkward for streaming, large uploads, or long-lived connections.
- The API surface must be consumed by multiple external services independent of the web app.

Rule: the agent loop must not run as an unbounded long-lived Next.js request handler. Next.js can run one bounded local harness step for playground usage, but background work belongs in a worker process.

## 3. Existing Frontend

Decision: `apps/web` (Next.js) is the only frontend.

The legacy rag-service frontends have been removed:

- `rag-service/public/test.html` (manual test console) and `rag-service/dashboard`
  (React/Vite dashboard source) were deleted with the rest of rag-service in R5
  (2026-07). `apps/web` `/playground` and `/dashboard` cover the same surface;
  the old sources live in git history / the `legacy-extras` branch.

Frontend approach:

1. `apps/web` playground drives the harness and shows the trace.
2. Keep only frontend surfaces that make harness state observable: trace visibility,
   knowledge hits, eval evidence, and conversation replay.
3. Avoid a full Chatwoot-style inbox rebuild in the first pass.

## 4. Chatwoot Role

Decision: Chatwoot is a reference product, not a runtime dependency.

We use Chatwoot to study and translate product concepts:

- Inbox
- Contact
- Conversation
- Message
- Assignment
- Internal note
- Label
- Handoff
- Canned response
- SLA/follow-up

We do not require Rails, Chatwoot deployment, or Chatwoot database in the target architecture.

## 5. Runtime Tools vs Development Skills

Use separate names.

Runtime concepts:

- `tools`: executable capabilities such as order lookup, availability check, media lookup, and handoff.
- `playbooks`: business conversation flows.（词汇保留；曾有 schema-only 的 playbooks 模块，2026-07 简化中因无执行引擎而移除，需要时再随执行器一起引入）
- `policies`: approval, escalation, and safety rules.
- `knowledge`: FAQ, product, policy, and historical answer sources.

Development concepts:

- `dev skills`: agent-side skills and plugins used while developing.
- Project-level dev-skill files were removed in the 2026-07 simplification (history preserved on the `legacy-extras` branch); the practices they encoded live on as conventions, not files.
- Non-trivial or high-risk development should include at least one read-only sub-agent grill before completion; sub-agent collaboration remains tree-shaped with the main agent as controller.
- Open-source or external skills can be adopted or adapted only with recorded provenance, license compatibility, and local changes (see `archive/open-source-adoption.md`).

Do not call customer-service runtime capabilities "skills" in product docs.

## 6. Session and Memory

Current state (updated 2026-07):

- `agent_sessions` is a real SQLite session store (`packages/db`); the playground route loads/creates a session per conversation.
- Conversations are keyed by `customerId`, `productId`, and `conversationId`.
- New-loop memory writes go to SQLite JSON columns (recentMessages only so far). SQLite is now the sole memory source; the legacy `rag-service/data/memory-store.json` read-only fallback was dropped from `apps/web` when rag-service was retired (R5).
- Recent messages, summaries, profile facts, orchestration state, and reviews are stored under `CustomerMemory` and `ProductMemory`.

Decision:

- Use SQLite for MVP sessions and lightweight state.
- Keep the current memory shape mostly intact.
- Move from JSON file to SQLite tables with JSON columns instead of redesigning memory now.

Suggested MVP tables:

```text
agent_sessions
  id
  customer_id
  product_id
  conversation_id
  status
  current_step
  created_at
  updated_at

customer_memories
  customer_id
  global_summary
  session_context_json
  body_profiles_json
  updated_at

product_memories
  customer_id
  product_id
  conversation_id
  summary
  recent_messages_json
  conversation_profile_json
  reviews_json
  updated_at

agent_traces
  id
  session_id
  event_type
  intent
  action
  input_json
  output_json
  tool_calls_json
  references_json
  created_at
```

Postgres can replace SQLite later when multi-user concurrency, deployment topology, or data volume requires it.

## 7. DeepSeek Model Lane, Agents SDK, and Harness Core

Decision: `agent = model + harness`. Chatty's model is `deepseek-v4-pro`; the
harness is the part we design and evolve. `OPENAI_*` env names and the `openai`
npm package are compatibility plumbing for DeepSeek's OpenAI-format Chat
Completions API, not a product decision to target OpenAI models.

The first live path is the customer-service Harness Core:

- `scheduleCustomerServiceTask`: maps a customer utterance into a narrow service task
  (`collect_missing_info` / `answer_question` / `check_availability` / `handoff` / `follow_up`).
- `buildCustomerServiceContext`: assembles customer, product, memory, policy, and retrieved context fragments.
- `parseCustomerServiceOutput`: parses strict JSON action output with a deterministic fallback.
- `executeCustomerServiceAction`: runs low-risk tools through policy-aware executors and escalates sensitive actions.
- `runCustomerServiceHarnessStep`: returns reply, terminality, tool calls, memory patch, and trace.

This keeps Chatty scoped to a rental customer-service project instead of a
general-purpose agent runtime. SDK usage replaces model/tool orchestration where
DeepSeek's OpenAI-format endpoint is compatible, but it must not move task
scheduling, executor policy, business memory, or trace contracts out of
Chatty's control. Deliberately out of scope for
the harness core: terminal/file tools, MCP, background workers, multi-agent
routing, and any new GUI.

Current live model path:

- DeepSeek `deepseek-v4-pro` via `@openai/agents` `OpenAIChatCompletionsModel`
  by default when an API key is present.
- Low-level DeepSeek Chat Completions adapter utilities remain for JSON
  extraction, telemetry, eval, and adapter tests; they are not an env-routable
  runtime lane.
- Harness compose path (`apps/web` playground, live LLM by default when a key is
  present; no key or model failure falls back deterministically).
- Agentic search (`search_knowledge`) uses SDK function tools in the SDK lane,
  while execution still goes through Chatty registry, policy, knowledge
  fragments, and persisted trace.
- Reply generation fallback.
- Evaluator judge (`eval/judge.ts`).
- Usage telemetry for DeepSeek cache hit/miss tokens, output tokens, total tokens, and estimated CNY cost.

DeepSeek compatibility that is safe to rely on:

- Chat Completions request/response shape.
- Function tool calls and `role: "tool"` result messages.
- `response_format: { "type": "json_object" }`, with explicit JSON instruction in prompt and parser fallback.
- `thinking` and `reasoning_effort` as DeepSeek-specific tuning knobs.
- Context-cache usage fields for observability.

OpenAI Agents SDK TypeScript is adopted for the compatible parts:

- Use SDK `OpenAIChatCompletionsModel` with a DeepSeek base URL; do not switch
  the project target to OpenAI models.
- Use SDK function tools only when they map back to Chatty's typed tool registry and policy gate.
- Use SDK Session only as an adapter over Chatty SQLite memory/session; do not use OpenAI server-managed state as source of truth.
- Use SDK human-in-the-loop/interruption semantics only if decisions still persist to Chatty trace/review tables.
- Use SDK tracing only as a secondary view; Chatty's persisted trace remains canonical.

Do not assume these OpenAI-only surfaces work with DeepSeek:

- Responses API.
- OpenAI hosted tools such as hosted web/file/code tools.
- OpenAI Conversations API server-managed state.
- OpenAI tracing export as the only telemetry backend.

All model calls should go through `packages/llm` adapters so DeepSeek-specific
compatibility stays testable and product logic remains independent of transport
details.

## 8. AgentKit and Agent Builder

Decision: use AgentKit and Agent Builder for design/prototyping, not as production source of truth.

Workflow:

1. Prototype workflows in Agent Builder when visual iteration helps.
2. Export or translate useful designs into TypeScript agent recipes.
3. Store experiments under `experiments/agent-builder/`.
4. Promote only reviewed code into `packages/agent-core` and `packages/llm`.

Production requirements for promoted workflows:

- Typed input/output schema.
- Tool schema.
- Guardrail.
- Memory read/write policy.
- Handoff policy.
- Golden eval cases.
- Trace fields.

## 9. Agent-First Mermaid Architecture

For the complete diagram set, use
[current-architecture.md](current-architecture.md). The high-level architecture
is agent-first: the framework is an edge adapter, while the stable product
surface is the harness contract.

```mermaid
flowchart LR
  Event["ConversationEvent"] --> Harness["agent-core harness"]
  Harness --> Task["task scheduling"]
  Task --> Context["context assembly"]
  Context --> Compose["compose<br/>LLM optional"]
  Compose --> Parser["output parser"]
  Parser --> Executor["policy-aware executor"]
  Executor --> Registry["runtime tool registry"]
  Context --> Memory["SQLite memory/session"]
  Context --> Knowledge["agentic search<br/>search_knowledge"]
  Knowledge --> FTS["SQLite FTS5 + LIKE"]
  Compose --> LLM["Chat Completions adapter"]
  Executor --> Trace["trace + memory patch"]
  Trace --> Eval["tests / smoke / golden eval"]
```

## 10. Design Artifacts

Maintain architecture and product design in `docs/`.

Recommended artifacts:

- Mermaid diagrams in markdown for architecture and data flow.
- Figma for UI flow and information architecture when product screens need precision.
- Canva for presentation-style stakeholder summaries.

The repository source of truth remains markdown under `docs/`. Figma/Canva links should be referenced from docs instead of replacing docs.

## 11. Retrieval and Knowledge Access: Model Inference Over RAG

Decision: the target architecture uses no LangChain/LlamaIndex, no embedding-based
RAG pipeline, and no vector database. The model is strong enough that the
harness should expose better materials to the model rather than hide decisions
inside a retrieval pipeline. Knowledge access is built from four parts:

1. **Memory done right.** Session/customer memory lives in SQLite repositories and
   is assembled into context deliberately (`buildCustomerServiceContext`), not
   retrieved by similarity.
2. **Deliberate chunking, indexing, and summarization.** Knowledge content is split
   and indexed for exact/fuzzy lookup (SQLite FTS5 planned), with summaries written
   at indexing time — instead of blind chunk-and-embed.
3. **Search as an agent tool.** The model gets a `search_knowledge` tool and decides
   when and what to search across turns, replacing pipeline-fixed top-k retrieval.
   This also leaves room for future multi-agent search: a subagent may perform
   fuzzy search and report findings, but retrieval remains an explicit tool action
   in the harness trace.
4. **DeepSeek pro inference dominates latency and cost.** The latency bottleneck
   is the `deepseek-v4-pro` model call, not retrieval I/O. Consequently the
   search implementation stays simple (FTS/LIKE is enough) — no Redis, no
   caching layers, no I/O micro-optimization: shaving retrieval from 0.1s to
   0.01s is invisible next to a multi-second model call. Optimization work goes
   into prompt stability, context size, tool-call count, and DeepSeek cache/cost
   telemetry.

Consequence: the legacy `rag-service` lane is fully retired (R5, 2026-07). The
qdrant + embeddings retrieval subsystem went first (R4, 2026-07): agentic search
(FTS5 + `search_knowledge`) is the live retrieval path. The designed retirement
gate was "harness lane at golden parity (11/11) first", but a user decision
overrode it — the *whole* rag-service runtime (answerQuestion / orchestrator /
memory-store, ~6300 lines) was deleted directly without chasing parity (harness
lane best 13/14), and the evaluation assets (judge + golden runner + scenarios)
were moved to root-level `eval/`. The end state is a single harness lane. Eval
quality is the invariant; the whole legacy runtime is what got swapped out.

## 12. Still Open

1. Whether to introduce Temporal later. Current decision: defer.
2. Whether Next.js Route Handlers are sufficient for all public API needs. Current decision: yes for MVP.
3. Whether SQLite remains local-only or becomes production MVP storage. Current decision: use SQLite for MVP unless deployment constraints force Postgres.
4. ~~How much of the existing Vite dashboard gets migrated into Next.js.~~ Resolved 2026-07: apps/web rebuilt `/dashboard`; the legacy Vite dashboard package was removed.
