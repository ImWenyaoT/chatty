# Context Map

Chatty is a pnpm monorepo. Its ubiquitous language spans several bounded contexts — one per package/app, plus the evaluation and retrieval surfaces. This map is the entry point the engineering skills read first: it carries the cross-cutting vocabulary and points at the per-context `CONTEXT.md` files.

## Shared vocabulary

Cross-cutting terms that span every context (read these for any concept not specific to one context):

- **Harness / Chatty Harness** — the agent runtime boundary: context assembly, bounded tools, loop control, policy, execution, completion verification, and trace. Chatty's irreducible value, not a prompt wrapper.
- **Chatty Agent** — DeepSeek (the Model) + Chatty Harness. The Model understands intent and chooses actions; the Harness constrains, executes, and verifies them.
- **Agent Not Chatbot / Not Workflow** — completes real business work through a Model-directed reasoning-and-acting loop; a reply without a verified result or traceable Handoff is not completion.
- **Reference-Guided Minimalism** — start from the smallest teachable `learn-claude-code` agent loop, then add only Chatty's required business behaviour; OpenAI Agents SDK is the implementation floor where it owns the loop. Full Claude Code is a behavioural reference, not a complexity budget.
- **Agents SDK Adapter Boundary** — OpenAI Agents SDK supplies generic model/tool-loop plumbing for DeepSeek's OpenAI-format endpoint; a replaceable dependency, not the agent architecture.
- **Agentic Search over RAG** — retrieval is exposed as a bounded agent tool over well-indexed, summarized content plus memory. No RAG pipeline, no vector database.
- **Transaction Context** — recent conversation facts needed to finish the current transaction. It applies to every customer but does not become Long-term Customer Memory merely because it was mentioned.
- **Repeat Customer** — a customer with at least two paid or otherwise confirmed orders. Only Repeat Customers are eligible for Long-term Customer Memory.
- **Long-term Customer Memory** — source-backed durable customer facts and preferences retained for future transactions after Repeat Customer eligibility. It is distinct from transient Context and from the shared Knowledge Base.
- **Agent Instructions** — Chatty-owned operating constraints that are always loaded for the Model, analogous to a runtime `AGENTS.md`: identity, tool rules, safety boundaries, escalation rules, and completion discipline. They are neither Memory nor searchable customer-facing facts.
- **Knowledge Base** — seller-verified product and operational facts shared across customers and searched as evidence. It is not Agent Instructions, customer Memory, or raw conversation history.
- **Customer-service Agent MVP** — a runnable local demo in which the Chatty Agent completes verifiable business work through tools and preserves the outcome. It does not require every adapter to connect to a production external system.
- **Local Business System** — the MVP's SQLite-backed source of truth for conversations, memory, traces, workflow state, handoffs, follow-ups, and indexed knowledge. It is the real business system for the demo, not a temporary substitute for a mandatory remote database.
- **Demo Business Data** — synthetic or anonymized records stored in the Local Business System and treated as the demo's source of truth. The records may be invented, but reads and writes against them must be real and verifiable.
- **Demo Adapter** — a bounded local implementation that performs real reads and writes against Demo Business Data without requiring a production integration.
- **Fulfillment Mode** — whether the customer intends to rent or buy a product. The Model resolves the mode from conversation context or asks when ambiguous; the Harness validates the selected business tool's required input.
- **Business Tool Backend** — the minimal conventional commerce behaviour behind Chatty's tools, persisted in SQLite for the demo. It exists to make Agent work executable and verifiable, not to make Chatty an ecommerce-platform project.
- **Durable Task** — unresolved work that must survive the current turn because it waits for a customer, time, human, or prerequisite. Synchronous questions and tool calls complete inside the Agent loop and leave a Trace rather than a Durable Task.
- **Handoff Trigger** — either a Model-selected escalation or a Harness-enforced response to a deterministic boundary such as required human approval, exhausted safe recovery, or an unsupported operation. Both forms create the same Durable Handoff.
- **Handoff Resolution** — trusted human judgment, authorization, or facts attached to the existing Durable Task. The same Chatty Agent resumes from it, continues tool work when needed, and returns the customer-facing result.
- **Learn Chatty** — the executable teaching surface that explains Chatty with minimal code. It is outside the current production mainline but remains a maintained companion rather than disposable prototype code.

## Contexts

| Context | Location | Owns | `CONTEXT.md` |
| --- | --- | --- | --- |
| Harness runtime | `packages/agent-core` (`@rental/agent-core`) | Bounded tool space, Model-directed task scheduling, execution policy, completion verification | [`CONTEXT.md`](packages/agent-core/CONTEXT.md) |
| Model plumbing | `packages/llm` (`@rental/llm`) | DeepSeek integration, Agents SDK adapter boundary, Chat Completions fallback | lazy |
| Harness store | `packages/db` (`@rental/db`) | SQLite persistence: sessions, Transaction Context, Long-term Customer Memory, traces, FTS5 Knowledge Base index | [`CONTEXT.md`](packages/db/CONTEXT.md) |
| Shared contracts | `packages/shared` (`@rental/shared`) | Browser-safe API contracts and shared types | lazy |
| Seller workspace | `apps/web` (`@chatty/web`) | Web demo surfaces, Frontend Experience Contract | lazy |
| Evaluation | `eval` | Chat-completions eval lane, golden evals, harness validation | lazy |
| Search / retrieval | `packages/agent-core/src/search-execution.ts` + `packages/db/src/knowledge-index.ts` + `knowledge` | Search Execution, agentic search over indexed and summarized content | lazy |
| Learning surface | `learn-chatty` | Minimal executable explanations of the mainline Agent and Harness | lazy |

Per-context `CONTEXT.md` files are marked **lazy**: they do not exist yet and are created by `/domain-modeling` when a context-specific term or decision actually gets resolved. Absence is not an error — treat it as "not resolved yet".

## ADRs

- **System-wide decisions**: `docs/adr/`
- **Context-scoped decisions**: `<context>/docs/adr/` (e.g. `packages/agent-core/docs/adr/`)

Both are created lazily as decisions get recorded.
