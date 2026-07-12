# Context Map

Chatty is a pnpm monorepo. Its ubiquitous language spans several bounded contexts — one per package/app, plus the evaluation and retrieval surfaces. This map is the entry point the engineering skills read first: it points at the per-context `CONTEXT.md` files and at the shared, system-wide glossary.

## Shared glossary

- **`CONTEXT.md`** (repo root) — system-wide ubiquitous language shared across every context: _Harness_, _Chatty Harness_, _Chatty Agent_, _Agent Not Chatbot_, _Reference-Bound Development_, and the other cross-cutting terms. Read this for any concept that isn't specific to a single context.

## Contexts

| Context | Location | Owns | `CONTEXT.md` |
| --- | --- | --- | --- |
| Harness runtime | `packages/agent-core` (`@rental/agent-core`) | Deterministic task scheduling, loop/flow control, executor dispatch, tool calling | lazy |
| Model plumbing | `packages/llm` (`@rental/llm`) | DeepSeek integration, Agents SDK adapter boundary, Chat Completions fallback | lazy |
| Harness store | `packages/db` (`@rental/db`) | SQLite persistence: sessions, transaction-scoped memory, traces, FTS5 knowledge index | lazy |
| Shared contracts | `packages/shared` (`@rental/shared`) | Browser-safe API contracts and shared types | lazy |
| Seller workspace | `apps/web` (`@chatty/web`) | Web demo surfaces, Frontend Experience Contract | lazy |
| Evaluation | `eval` | Chat-completions eval lane, golden evals, harness validation | lazy |
| Search / retrieval | `rag-service` + `knowledge` | Search Execution, agentic search over indexed and summarized content | lazy |

Per-context `CONTEXT.md` files are marked **lazy**: they do not exist yet and are created by `/domain-modeling` when a context-specific term or decision actually gets resolved. Absence is not an error — treat it as "not resolved yet".

## ADRs

- **System-wide decisions**: `docs/adr/`
- **Context-scoped decisions**: `<context>/docs/adr/` (e.g. `packages/agent-core/docs/adr/`)

Both are created lazily as decisions get recorded.
