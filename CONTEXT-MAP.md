# Context Map

Chatty is a pnpm monorepo. Its ubiquitous language spans several bounded contexts — one per package/app, plus the evaluation and retrieval surfaces. This map is the entry point the engineering skills read first: it carries the cross-cutting vocabulary and points at the per-context `CONTEXT.md` files.

## Shared vocabulary

Cross-cutting terms that span every context (read these for any concept not specific to one context):

- **Harness / Chatty Harness** — the agent runtime boundary: context assembly, memory, loop/flow control, tool calling, policy, trace. Chatty's irreducible value, not a prompt wrapper.
- **Chatty Agent** — DeepSeek (the model) + Chatty Harness. The model-plus-harness runtime boundary, not the web UI.
- **Agent Not Chatbot / Not Workflow** — plans and executes bounded task flow under harness control; the model participates in choosing the next step, but only inside scheduled task bounds.
- **Reference-Bound Development** — kept between the JD floor (`docs/jd.md`) and the single upper bound `claude-code`. Each capability takes `claude-code` as its primary reference before implementation.
- **Agents SDK Adapter Boundary** — OpenAI Agents SDK supplies generic model/tool-loop plumbing for DeepSeek's OpenAI-format endpoint; a replaceable dependency, not the agent architecture.
- **Agentic Search over RAG** — retrieval is exposed as a bounded agent tool over well-indexed, summarized content plus memory. No RAG pipeline, no vector database.
- **Transaction-Scoped Memory** — preserve the recent transaction context needed to finish the current task, not a social-chat archive.
- **SQLite Harness Store** — MVP persistence for sessions, transaction-scoped memory, traces, and FTS5 knowledge index (SQLite via `better-sqlite3`).

## Contexts

| Context | Location | Owns | `CONTEXT.md` |
| --- | --- | --- | --- |
| Harness runtime | `packages/agent-core` (`@rental/agent-core`) | Deterministic task scheduling, loop/flow control, executor dispatch, tool calling | lazy |
| Model plumbing | `packages/llm` (`@rental/llm`) | DeepSeek integration, Agents SDK adapter boundary, Chat Completions fallback | lazy |
| Harness store | `packages/db` (`@rental/db`) | SQLite persistence: sessions, transaction-scoped memory, traces, FTS5 knowledge index | lazy |
| Shared contracts | `packages/shared` (`@rental/shared`) | Browser-safe API contracts and shared types | lazy |
| Seller workspace | `apps/web` (`@chatty/web`) | Web demo surfaces, Frontend Experience Contract | lazy |
| Evaluation | `eval` | Chat-completions eval lane, golden evals, harness validation | lazy |
| Search / retrieval | `packages/agent-core/src/search-execution.ts` + `packages/db/src/knowledge-index.ts` + `knowledge` | Search Execution, agentic search over indexed and summarized content | lazy |

Per-context `CONTEXT.md` files are marked **lazy**: they do not exist yet and are created by `/domain-modeling` when a context-specific term or decision actually gets resolved. Absence is not an error — treat it as "not resolved yet".

## ADRs

- **System-wide decisions**: `docs/adr/`
- **Context-scoped decisions**: `<context>/docs/adr/` (e.g. `packages/agent-core/docs/adr/`)

Both are created lazily as decisions get recorded.
