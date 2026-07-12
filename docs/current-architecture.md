# Chatty Current Architecture

Last updated: 2026-07-12

This is the supplemental diagram set for the current implementation. The main
agent architecture design document is [design.md](design.md), which owns the
`docs/jd.md` lower bound, OpenClaw/Codex/Claude Code upper bound, design
choices, the canonical harness spine, and per-component rationale. This file
holds only the integrated views design.md's per-component decomposition does
not draw: the one-turn sequence, cross-package component owners, and the
tool/risk map.

Update this file whenever a change alters harness flow, tool behavior, memory
shape, knowledge access, model composition, trace fields, or eval gates.

## 0. 90-second Version

If you only keep one mental model, keep this:

```text
message -> scheduler -> context -> compose/search -> parser -> executor -> trace
```

Chatty is not primarily a Next.js app. It is a small customer-service agent
harness:

- **Scheduler** decides the narrow task for one turn.
- **Context builder** assembles task, user message, product, memory, and
  knowledge fragments.
- **Compose** asks DeepSeek pro through the Agents SDK. Missing configuration is
  a 503 response; provider or invalid-output failures are 502 responses.
- **search_knowledge** is the only agentic knowledge loop, bounded to 3 calls.
- **Parser** turns model text into a safe `CustomerServiceAction`.
- **Executor** applies tool policy and risk gates before any side effect.
- **Trace + memory** make every turn observable and testable.

Read only these files first:

- `packages/agent-core/src/customer-harness.ts` for the turn pipeline.
- `packages/agent-core/src/tools/registry.ts` for tool shape and risk.
- `docs/design.md` for the lower/upper complexity bounds and harness component shapes.
- `docs/tech-stack-decisions.md` for decisions and rejected options.

Everything else is supporting detail or history.

## 1. Complexity Budget

Keep the architecture boring:

- One active agent harness path.
- One knowledge-search mechanism: `search_knowledge` over SQLite FTS5/LIKE.
- One live model integration surface: DeepSeek `deepseek-v4-pro` through OpenAI Agents SDK over its OpenAI-format endpoint.
- One persistence family for MVP state: SQLite repositories.
- One quality story: automated tests + smoke + manual real-LLM golden eval.

Avoid adding a new runtime lane, workflow engine, vector database, agent
framework, or background loop unless the existing harness contract cannot
express the required behavior and there is a test/eval showing the gap.

## 2. Agent Harness Spine

The canonical harness spine — message → scheduler → context → compose/search →
parser → executor → trace — is drawn once in [design.md](design.md) (§0 总览).
This file does not re-draw it; what matters here is the contract that spine
implements.

The important boundary is not "web vs backend"; it is the harness contract:

```text
(event, memory, registry, optional model/tool loop) ->
  { step, trace }
```

`step` carries the customer-facing reply, terminality, tool calls, next status,
and memory patch. `trace` carries the inspectable harness path: task, context,
parsed action, tool calls, and tool results.

## 3. One Turn Sequence

```mermaid
sequenceDiagram
  participant User as Customer
  participant Adapter as Edge adapter
  participant Harness as agent-core harness
  participant Memory as SQLite memory/session
  participant Search as search_knowledge
  participant LLM as DeepSeek Agents SDK adapter
  participant Tools as Tool registry + policy
  participant Eval as Tests / smoke / eval

  User->>Adapter: message
  Adapter->>Memory: load/create session snapshot
  Adapter->>Harness: runCustomerServiceHarnessStep
  Harness->>Harness: schedule task
  Harness->>Harness: build context fragments
  Harness->>LLM: optional compose/tool-loop call
  LLM-->>Harness: text or tool_calls
  Harness->>Search: optional bounded knowledge search
  Search-->>Harness: knowledge fragment text
  Harness->>Harness: parse action JSON
  Harness->>Tools: invokeWithPolicy(action)
  Tools-->>Harness: tool result / approval / deny
  Harness-->>Adapter: step + trace
  Adapter->>Memory: persist trace output and continuity memory
  Eval->>Harness: same contract under automated checks
```

## 4. Agent Components and Code Owners

```mermaid
flowchart TD
  subgraph Core["packages/agent-core"]
    S["scheduler<br/>CustomerServiceTask"]
    C["context builder<br/>ContextFragment[]"]
    M["model output composer<br/>DeepSeek Agents SDK"]
    P["parser<br/>CustomerServiceAction"]
    E["executor<br/>terminality + toolCalls"]
    R["tool registry<br/>risk + parameters + execute"]
    Policy["policy<br/>allow / require_approval / deny"]
  end

  subgraph DB["packages/db"]
    Sessions["session repository"]
    Memories["memory repository"]
    Traces["trace repository"]
    KIndex["knowledge index<br/>SQLite FTS5"]
  end

  subgraph LLM["packages/llm"]
    Chat["DeepSeek Chat Completions adapter"]
    Env["env reader"]
    JSON["tolerant JSON extraction"]
  end

  subgraph Shared["packages/shared"]
    Types["types"]
    Schemas["schemas"]
    Gates["quality-gates contract"]
  end

  subgraph Eval["eval/"]
    Runner["golden runner"]
    Judge["LLM judge"]
    Golden["scenario YAML"]
  end

  S --> C --> M --> P --> E
  E --> R --> Policy
  C --> Memories
  C --> KIndex
  M --> Chat
  P --> Types
  Runner --> Core
  Runner --> Judge
  Golden --> Runner
  Core --> Traces
  Core --> Sessions
  Core --> Shared
```

## 5. Tool and Risk Model

```mermaid
flowchart LR
  Action["CustomerServiceAction"] --> Gate["invokeWithPolicy"]
  Gate --> Low["low risk<br/>auto execute"]
  Gate --> Medium["medium risk<br/>require approval / handoff"]
  Gate --> High["high risk<br/>never auto execute"]
  Gate --> Closed["closed session<br/>deny all side effects"]

  Low --> Product["get_product"]
  Low --> Availability["check_availability"]
  Low --> Search["search_knowledge"]
  Medium --> Handoff["create_handoff"]
  Medium --> Followup["schedule_followup"]
  High --> Refund["issue_refund"]
  Closed --> Deny["PolicyDenyError"]
```

Tool policy is the harness safety boundary. The customer-service agent has no
terminal or file tools; its risky surface is business-side effects.

## 6. Knowledge Access: Agentic Search, Not RAG

```mermaid
flowchart TD
  Corpus["knowledge/<br/>products, rules, history"] --> Chunker["chunkKnowledgeFile"]
  Chunker --> Index["SQLite FTS5 index<br/>knowledge_chunks"]
  Query["Model decides to search"] --> SearchTool["search_knowledge(query)"]
  SearchTool --> Index
  Index --> Match["trigram MATCH<br/>or 2-char LIKE fallback"]
  Match --> Format["bounded text result<br/>top 3 + truncation"]
  Format --> Fragment["kind: knowledge<br/>ContextFragment"]
  Fragment --> Compose["compose final answer"]
```

Current stance:

- No vector database.
- No embedding retrieval subsystem.
- Use memory deliberately instead of similarity-retrieving transient state.
- Chunk, index, and summarize knowledge before exposing it to the harness.
- Give the model an explicit search tool so the agent can decide when to search.
- Product prices, sizes, and exact structured facts should prefer structured
  tools over free-text knowledge search.
- Search failure must degrade to a usable answer path instead of breaking a turn.

## 7. Quality Gates Around the Agent

```mermaid
flowchart LR
  Change["Code or prompt change"] --> Unit["Unit tests<br/>pure behavior"]
  Change --> Integration["Lightweight integration<br/>harness + db + tools"]
  Change --> Smoke["pnpm smoke<br/>no-network core path"]
  Change --> Typecheck["pnpm typecheck<br/>contract drift"]
  Change --> Build["pnpm build<br/>production build"]
  Change --> Eval["manual pnpm eval<br/>real LLM golden regression"]

  Unit --> CI["CI"]
  Integration --> CI
  Smoke --> CI
  Typecheck --> CI
  Build --> CI
  Eval --> ManualGate["manual eval workflow<br/>secrets + judge noise"]
```

Every behavior that can be automatically verified should be automatically
verified. The executable quality-gate contract lives in
`packages/shared/src/quality-gates.ts`.

## 8. Documentation Map

```mermaid
flowchart TD
  Design["design.md<br/>main design doc + canonical spine"] --> Current["current-architecture.md<br/>supplemental integrated diagrams"]
  Design --> Decisions["tech-stack-decisions.md<br/>decision registry"]
  Design --> Archive["docs/archive/<br/>historical records"]
  Archive --> SearchDesign["agentic-search-design.md<br/>search subsystem history"]
  Archive --> LoopPlan["loop-engineering-plan.md<br/>migration history"]
  Archive --> Historical["architecture.md<br/>RW-1 historical target spec"]
```

Start from `docs/design.md`: it is the main design document and owns the
canonical harness spine. Use this file for the supplemental integrated diagrams,
and `docs/tech-stack-decisions.md` for why a technology or product direction was
chosen.
