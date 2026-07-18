# Chatty Agent MVP Simplification

## Problem Statement

Chatty already runs as a customer-service Agent, but its implementation grew from the complexity shape of full Claude Code and a web control plane rather than from the smallest teachable agent loop. The result mixes Model-directed action selection with workflow orchestration, extracts long-term memory before it has customer value, exposes simulated business facts as successful tools, hardcodes Agent Instructions, and maintains overlapping run, job, handoff, and task concepts. This makes the Harness harder to understand and change without adding customer value.

The user needs Chatty to remain a real single Agent—not a chatbot and not a pre-routed workflow—while reducing the implementation to the minimum required by its verified customer-service behaviours. Simplification must preserve externally observable outcomes and use OpenAI Agents SDK primitives wherever the SDK already owns the loop.

## Solution

Rebuild the active Chatty path as a small composition of the `learn-claude-code` layers that the customer-service domain actually needs: one Agents SDK loop, bounded business tools, runtime Agent Instructions, Transaction Context, a source-backed Repeat Customer Memory gate, a SQLite Durable Task System for work that cannot finish in the current turn, background delivery for delayed work, and deterministic Harness completion checks.

The Model receives Context and the bounded tool set, understands intent, and chooses tools. The Harness validates schemas, permissions, trusted identifiers, business-tool receipts, task transitions, and completion. SQLite is the demo's real Local Business System. Product and customer records may be synthetic or anonymized, but tool reads and writes must be real. Simple synchronous work leaves a Trace; only unresolved work creates a Durable Task. Human Handoff resumes the same task and the same Agent.

## User Stories

1. As a customer, I want Chatty to understand my request and choose the appropriate business tool, so that I receive an actual resolution rather than scripted routing.
2. As a customer, I want inventory answers to come from stored product and stock records, so that “有货” is a verifiable fact rather than a fixed demo response.
3. As a customer, I want Chatty to distinguish rental from buyout intent, so that it performs the correct conventional commerce operation.
4. As a customer, I want Chatty to ask when rental versus buyout is ambiguous, so that it never changes inventory under an assumed mode.
5. As a customer, I want rental availability to account for product, size, quantity, and requested dates, so that overlapping demand is handled consistently.
6. As a customer, I want buyout and rental updates to change the same SQLite-backed source of truth used by later availability checks, so that actions have durable effects.
7. As a customer, I want policy, price, sizing, and shop facts to come from seller-verified knowledge, so that the Agent does not invent them.
8. As a customer, I want ordinary greetings and non-business conversation to complete without artificial task records, so that the Agent remains natural and lightweight.
9. As a customer, I want missing information to be requested explicitly, so that the Agent does not fabricate required order or inventory fields.
10. As a customer, I want a request that needs a human to create a durable, traceable Handoff, so that “请联系人工客服” is never the entire resolution.
11. As a customer, I want the same Chatty Agent to resume after a human supplies a decision or authorization, so that the original task remains one auditable loop.
12. As a customer, I want delayed follow-ups to survive process restarts and run at the requested time, so that 24-hour service does not depend on a live human.
13. As a seller, I want Chatty's identity, safety rules, tool discipline, escalation rules, and completion rules maintained as Agent Instructions, so that they are always applied and are not confused with Memory.
14. As a seller, I want Agent Instructions assembled at runtime from stable sections, so that changing one concern does not require editing a monolithic prompt.
15. As a seller, I want customer conversations to remain Transaction Context until the customer has a second confirmed order, so that one-off chats do not create low-value long-term profiles.
16. As a seller, I want explicit repeat-customer facts to retain their source Trace, so that Long-term Customer Memory is verifiable.
17. As a seller, I want Model-inferred preferences to remain Memory Candidates until corroborated or reviewed, so that guesses do not become customer facts.
18. As a seller, I want shared product and operational facts kept in the Knowledge Base rather than customer Memory, so that all customers use one verified source.
19. As an operator, I want approval requirements, exhausted safe recovery, and unsupported operations to force a Durable Handoff, so that deterministic safety boundaries do not depend on Model discretion.
20. As an operator, I want a Durable Task to move through a small persisted lifecycle with prerequisite checks, so that unresolved work can recover without a general workflow engine.
21. As an operator, I want synchronous requests to avoid Durable Task creation, so that task storage represents open work rather than duplicating Trace history.
22. As an operator, I want every completed task to reference verified tool or human evidence, so that Model confidence alone cannot mark work complete.
23. As a developer, I want OpenAI Agents SDK to own model/tool/result orchestration, so that Chatty does not maintain a second custom agent loop.
24. As a developer, I want one registry seam for adding a business tool, so that adding a capability does not modify the core loop.
25. As a developer, I want the production path and golden evaluation path to use the same Harness runner, so that eval results describe production behaviour.
26. As a developer, I want Learn Chatty to explain the resulting minimum implementation without becoming a second production system, so that the architecture stays teachable.
27. As a maintainer, I want replaced routing, prompt, memory, and workflow abstractions deleted after migration, so that compatibility layers do not preserve the old complexity indefinitely.
28. As a maintainer, I want current public API responses, Trace observability, cancellation, idempotent replay, Handoff resume, and follow-up delivery preserved where they are externally observable, so that simplification does not silently regress behaviour.

## Implementation Decisions

- Chatty remains a single Agent: DeepSeek Model plus Chatty Harness. Multi-agent, subagent, team, MCP, skill, and worktree mechanisms are excluded.
- The active Model loop is the OpenAI Agents SDK `Agent`/function-tool/`Runner` loop over DeepSeek's OpenAI-compatible Chat Completions endpoint. Chatty does not implement another compose or no-tool-finalization loop.
- Model tool choice is Customer Service Task Scheduling. The Harness does not use keyword, regex, or deterministic intent preclassification.
- Agent Instructions are a distinct, always-loaded runtime artifact assembled as stable sections in the style of `learn-claude-code` s10. Repository development-agent instructions and Chatty runtime instructions remain separate.
- The Knowledge Base contains seller-verified shared facts and remains searchable through a bounded tool over the SQLite FTS index. It is not Memory and is not an instruction source for rules that must always apply.
- The Local Business System uses SQLite and conventional simplified commerce behaviour. Synthetic or anonymized seed data is allowed; fixed success responses are not.
- Inventory is quantity-based per product and size. Rental and buyout are supported as Fulfillment Modes without introducing individual-garment warehouse lifecycle modelling.
- Business tools own their domain transactions and return structured receipts. The Harness injects trusted customer, conversation, and product identifiers rather than accepting Model-supplied identity fields.
- A synchronous Agent loop leaves a Trace. A Durable Task is created only for work waiting on a customer, time, human, or prerequisite.
- The Durable Task System starts from `learn-claude-code` s12: persisted task records, a small lifecycle, prerequisite relationships, and Model-visible task tools. Single-Agent Chatty does not add multi-agent claim coordination unless required for a human Handoff owner.
- Existing cancellation, idempotency, restart recovery, Handoff resume, and delayed-delivery behaviour is retained behind smaller module boundaries. Internal control-plane types are not themselves compatibility contracts and may be replaced.
- Model-selected and Harness-enforced Handoffs create the same Durable Task shape. Human resolution is trusted input attached to that task; the same Agent resumes and produces the customer response.
- Tool/business failures are returned to the Agent while safe recovery remains. Permission gates and exhausted recovery are Harness concerns. A failed receipt cannot be reported as completed.
- Long-term Customer Memory is disabled until a second paid or otherwise confirmed order exists. Earlier messages remain Transaction Context and Trace.
- Explicit stable customer statements may be promoted with a source Trace after eligibility. Model inference remains a Memory Candidate until customer confirmation, repeated evidence, or human review.
- Background execution and scheduled follow-up use only the minimal s13/s14 behaviours required by the existing demo: durable scheduling, queue delivery, cancellation, idempotency, and recovery.
- Learn Chatty remains outside the current production path but is maintained as the executable explanation of the final minimum Harness.
- Full Claude Code remains a behavioural reference. `learn-claude-code` is the complexity starting point, and OpenAI Agents SDK is the lower bound where its abstractions apply.

## Testing Decisions

- Tests assert external behaviour and persisted evidence, not private helper structure.
- The primary core seam is one injected call to the public Harness step: a Conversation Event and Memory Snapshot enter; a reply, tool calls, completion state, memory patch, and Trace leave.
- The primary persisted seam is one customer-service turn against a disposable SQLite database. It proves Agent choice, business-tool state change, Trace, Durable Task/Handoff, and Memory eligibility without requiring the web UI.
- The public Next.js API contract remains covered by full-stack tests, but frontend styling is not part of this work.
- The Model/API boundary is mocked in deterministic tests by injecting an SDK runner; the actual Agents SDK loop is tested with its model seam, not replaced by a fake Chatty loop.
- Opt-in DeepSeek contract tests and golden evals prove real provider/tool compatibility without making ordinary unit tests depend on network credentials.
- Inventory tests prove initial seed data, date-overlap availability, state-changing rental/buyout operations, insufficient quantity, idempotency, and rollback on failure.
- Durable Task tests prove synchronous work creates no task; unresolved work creates one; prerequisites block; evidence gates completion; Handoff resumes the same task; restart recovery preserves state.
- Memory tests prove first-order conversations do not schedule long-term extraction, second confirmed orders enable it, explicit facts retain source Trace, inferences remain candidates, and transient needs stay in Transaction Context.
- Instruction tests prove the runtime Agent Instructions are loaded, the repository development `AGENTS.md` is not used as customer-agent policy, and prompt sections remain stable across tool rounds.
- Completion tests prove successful structured receipts complete work, failed/denied calls do not, and deterministic approval/recovery boundaries create Durable Handoffs.
- Existing workspace typecheck, full tests, core coverage thresholds, full-stack integration, worker integration, smoke, lint, and formatting remain release gates.

## Out of Scope

- Production SaaS inventory, order, payment, CRM, or Chatwoot integrations.
- A full ecommerce platform, payment architecture, warehouse fulfilment, shipping, cleaning, damage, return, or individual-garment lifecycle.
- Multi-agent teams, subagents, agent ownership protocols, autonomous task claiming, worktree isolation, MCP, or skills.
- A generic workflow engine or arbitrary user-authored DAG product.
- Vector databases, embedding retrieval, or a RAG pipeline.
- Rebuilding the web product or redesigning its visual presentation.
- Treating every conversation as long-term customer memory.
- Allowing customer messages or Model claims to directly change Agent Instructions or verified Knowledge Base content.

## Further Notes

- The current repository already contains working slices of the target behaviour, but several are behind heavier abstractions or demo stubs. Migration should use expand–migrate–contract where deleting an old abstraction would otherwise break broad callers.
- Current GitHub CLI authentication is invalid. This local spec is the authoritative draft until it can be published to the configured GitHub issue tracker with the `ready-for-agent` label.
- The accepted vocabulary and hard-to-reverse decisions live in the root Context Map, context-specific Context files, and ADRs 0002–0004.
