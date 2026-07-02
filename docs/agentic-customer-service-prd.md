# Agentic Customer Service PRD

Last updated: 2026-07-02

> **Supersession 说明**：本 PRD 是最初的探索文档。凡与
> [tech-stack-decisions.md](tech-stack-decisions.md) 冲突之处，以后者为准——
> 特别是：§3 的 "Chatwoot + Agent Sidecar" 主基座方案已被否决（Chatwoot 仅作产品参考），
> §17 M1 的 Chatwoot 集成随之作废；§18 的 dev-skills 清单对应的 .agents/skills 已移除。
> 保留原文供决策考古。

## 1. Background

Current codebase: `rag-service/`（仓库内相对路径）.

The current service is a vertical rental-clothing customer-service bot. It already has useful pieces:

- Action routing for deterministic business replies.
- A conversation state machine for product, rental period, body measurements, size, review, and order guidance.
- RAG over Qdrant or local vectors.
- File-backed customer/product memory.
- Async reply evaluation and dashboard.

But it is not yet a production customer-support agent harness. It is still one `/chat` request producing one reply. It lacks durable event processing, real tool-result continuation, human handoff workflow, external order/session facts as first-class context, and a clean separation between memory, RAG evidence, and workflow state.

## 2. Product Goal

Build Chatty, an agentic customer-service system for rental commerce that can:

1. Handle routine pre-sale and post-sale conversations automatically.
2. Continue a conversation across user messages, tool results, scheduled follow-ups, and human handoffs.
3. Use knowledge base, order history, product catalog, inventory, logistics, and buyer context without dumping everything into the model prompt.
4. Escalate to human agents with full context and safe recommendations.
5. Improve through evaluation, regression tests, and traceable failure review.

## 3. Recommended Open-Source Base

### Primary base: Chatwoot + Agent Sidecar

Use Chatwoot as the customer-support shell and build the intelligent agent as a sidecar/worker service.

Why Chatwoot:

- It is an open-source, self-hosted customer support platform.
- It already solves inbox, conversations, contacts, assignments, teams, handoff, live chat, and agent UI.
- It reduces the amount of product surface we need to build from scratch.
- It maps naturally to customer-service workflows: conversation, contact, message, assignment, label, note, handoff.

Reference:

- Chatwoot website: https://www.chatwoot.com/
- Chatwoot GitHub: https://github.com/chatwoot/chatwoot

### Agent orchestration candidate: LangGraph

Use LangGraph for the agent loop if we want a graph-based runtime with durable execution, human-in-the-loop control, state persistence, streaming, and resumable runs.

Reference:

- LangGraph docs: https://docs.langchain.com/oss/python/langgraph/overview
- LangGraph GitHub: https://github.com/langchain-ai/langgraph

### Alternative candidates

| Candidate | Use it for | Why not primary |
|---|---|---|
| Dify | Fast low-code workflow/RAG prototype | Good workflow builder, but less ideal if we need tight custom commerce state, Chatwoot handoff, and code-level harness control |
| Rasa | Traditional intent/flow controlled assistant | Strong for deterministic dialogue management, but the current product direction needs agentic tool/event orchestration |
| Current rag-service only | Quick iteration | Good prototype, but it would require rebuilding helpdesk/inbox/handoff/product ops from scratch |

Reference:

- Dify GitHub: https://github.com/langgenius/dify
- Rasa docs: https://rasa.com/docs/rasa/

## 4. Product Scope

### MVP

MVP should support one rental-commerce channel end to end:

- Receive incoming customer messages from Chatwoot webhook.
- Build context from contact, conversation, product link, order history, recent messages, and knowledge.
- Decide whether to answer, ask for missing info, call a tool, schedule a follow-up, or hand off.
- Reply back to Chatwoot.
- Persist agent state and trace.
- Let a human agent inspect state, override, and continue.
- Run offline golden tests and online evaluation.

### Out of Scope for MVP

- Multi-tenant billing.
- Full omnichannel custom integrations outside Chatwoot-supported channels.
- Autonomous refund/compensation execution.
- Fully automated catalog ingestion from arbitrary marketplaces.
- Fine-tuning.

## 5. Target Users

### Customer

Rental customer asking about product, size, rental period, price, stock, shipping, order status, or post-sale issue.

### Human agent

Store operator who handles escalations, reviews conversations, edits knowledge, and approves risky actions.

### Ops/admin

Person maintaining product catalog, knowledge base, workflows, evaluation reports, and prompt/action policies.

## 6. Core User Stories

1. As a customer, I can ask "这款多少钱 / 怎么租 / 发我图片" and get a concise answer.
2. As a customer, I can provide date, height, and weight in any order, and the agent remembers and advances the order flow.
3. As a customer, I can send corrections like "不是 5 月 8，是 5 月 10" and the agent updates state safely.
4. As a customer, I can ask for a human, complain, or request refund, and the system hands off with context.
5. As a human agent, I can see why the bot replied: intent, action, memory, RAG evidence, tool calls, and policy checks.
6. As an admin, I can run regression tests before deploying new prompts, policies, or knowledge.

## 7. Target Architecture

```text
Channel / Chatwoot
  -> Webhook Receiver
  -> Conversation Event Queue
  -> Agent Orchestrator
       -> Context Builder
       -> Policy / Guardrail
       -> Action Router
       -> Tool Executor
       -> Response Generator
       -> Memory Writer
       -> Evaluator
  -> Chatwoot Reply / Internal Note / Assignment / Handoff
```

## 8. Harness Design

### 8.1 Event Model

Replace single `/chat` thinking with a durable event model.

Events:

- `user_message`
- `agent_reply_sent`
- `tool_result`
- `scheduled_followup_due`
- `human_handoff_requested`
- `human_agent_replied`
- `order_status_changed`
- `evaluation_failed`
- `knowledge_updated`

Each event should contain:

- `eventId`
- `conversationId`
- `customerId`
- `source`
- `payload`
- `occurredAt`
- `traceId`

### 8.2 Orchestration Loop

The agent loop should be bounded and resumable:

```text
while steps < MAX_STEPS:
  event = read_next_event()
  context = build_context(event, state)
  decision = select_action(context)
  if decision.requires_tool:
    enqueue_tool_call()
    persist_state(waiting_for_tool)
    break
  if decision.requires_human:
    create_chatwoot_assignment_or_note()
    persist_state(waiting_for_human)
    break
  if decision.reply:
    send_reply()
    persist_state(waiting_for_user)
    break
```

This is the missing layer in the current implementation.

### 8.3 Action Model

Keep the current discriminated-union Action idea, but add execution semantics.

Each Action should declare:

- `kind`
- `riskLevel`
- `terminality`
- `requiredContext`
- `toolCalls`
- `replyPolicy`
- `handoffPolicy`

Example terminality:

- `reply_and_wait`
- `tool_then_continue`
- `schedule_and_wait`
- `handoff_and_wait`
- `close`

## 9. Context Design

Context must be lazy and layered.

### Context Layers

1. Request layer: current user message, attachments, channel metadata.
2. Conversation layer: recent messages, current state, pending tool calls.
3. Customer layer: profile, previous measurements, repeat-buyer status.
4. Commerce layer: product, order history, inventory, logistics.
5. Knowledge layer: retrieved policy/product/FAQ evidence.
6. Policy layer: safety rules, forbidden asks, escalation rules.

### Rule

Do not run RAG before knowing whether RAG is needed.

Current issue:

- The existing `answerQuestion()` performs `searchKnowledge()` before action selection.
- Small talk, confirmation, and handoff still pay embedding cost and receive irrelevant references.

Target behavior:

- `small_talk`: no RAG.
- `confirm`: no RAG unless confirming a factual answer.
- `provide_body` / `provide_period`: no RAG.
- `ask_info`: RAG or structured catalog lookup.
- `image_request`: media index lookup, not pure vector search.
- `post_order`: order/logistics tools first, RAG second.

## 10. Memory Design

Split memory into explicit stores.

### Stores

| Store | Purpose | Persistence |
|---|---|---|
| `ConversationState` | Current workflow state, pending slots, next action | durable DB |
| `CustomerProfile` | Stable facts: measurements, preferences, repeat-buyer info | durable DB |
| `SessionSummary` | Rolling summary of long conversation | durable DB |
| `ExternalFacts` | Order history, product link, marketplace intel | fetched/cached with TTL |
| `RetrievedEvidence` | RAG chunks for current turn | trace only, not long-term memory |
| `AgentTrace` | intent, action, tool calls, prompts, outputs, guardrails | durable observability store |

### Memory Write Policy

- Small talk updates recent message only.
- Corrections update facts with old value retained in audit history.
- External order facts are not rewritten as user memory.
- RAG evidence is not written into customer memory.
- Human override creates a policy/evaluation signal.

## 11. Tools

### MVP tools

- `get_product(productId)`
- `search_products(query)`
- `get_media(productId, mediaKind)`
- `check_availability(productId, size, rentalPeriod)`
- `calculate_price(productId, rentalPeriod, quantity)`
- `get_order_history(customerId)`
- `get_order_status(orderNo)`
- `create_handoff(conversationId, reason, context)`
- `schedule_followup(conversationId, dueAt, reason)`
- `add_internal_note(conversationId, note)`

### Tool Safety

Read-only tools can run automatically.

Write tools need policy:

- Low risk: internal note, follow-up schedule.
- Medium risk: customer-facing reply.
- High risk: refund, compensation, order modification, irreversible marketplace action.

High-risk actions require human approval.

## 12. Feedforward Design

Feedforward means using facts from the current message before they are persisted.

Keep and formalize the current `deriveNextProfile()` idea:

- Extract current-turn facts.
- Build a simulated next state.
- Route based on simulated state.
- Persist only after response/tool decision succeeds.

Examples:

- User says "5月8号，179cm 70kg" in one message.
- Agent should move directly to review confirmation.
- It should not ask for height/weight again just because memory has not been written yet.

## 13. Backforward / Feedback Design

Feedback should become a control loop, not just a dashboard record.

Signals:

- User correction.
- Human agent override.
- Low evaluator score.
- Handoff reason.
- Tool failure.
- Customer dissatisfaction keywords.

Outputs:

- Update conversation state.
- Create regression test candidate.
- Suggest policy/template patch.
- Flag knowledge gap.
- Block risky auto-reply patterns.

MVP should implement:

- Human override -> creates `review_signal`.
- Evaluator low score -> creates `failure_case`.
- Failure cases can be exported into golden tests.

## 14. RAG Design

RAG should be capability-specific.

### Retrieval types

- FAQ/policy retrieval.
- Product structured lookup.
- Product image/media lookup.
- Historical successful answers.
- Human escalation playbooks.

### Retrieval rules

- Prefer structured lookup over vector search when the user asks for product, price, size, image, inventory, or order.
- Vector RAG is only for natural-language policy/FAQ ambiguity.
- Image requests should query media metadata directly, with vector search as fallback.
- Every RAG answer must return citations/evidence to the trace, but not necessarily to the customer.

## 15. Handoff Design

Handoff should be first-class.

Handoff triggers:

- Explicit "转人工/投诉/退款/赔偿".
- Logistics too close to rental start date.
- Size uncertain or out of supported range.
- Payment/order modification.
- Low-confidence answer for high-risk policy.
- Tool failure on critical path.

Handoff payload to Chatwoot:

- User question.
- Conversation summary.
- Current state.
- Missing slots.
- Recommended next reply.
- Evidence and tool results.
- Risk reason.

## 16. Evaluation

### Offline

- Golden conversations.
- Action accuracy.
- Slot extraction accuracy.
- No forbidden questions.
- Handoff trigger accuracy.
- RAG relevance.
- Regression diff by prompt/model/version.

### Online

- Auto evaluator score.
- Human override rate.
- Handoff rate.
- First response time.
- Resolution rate.
- Tool failure rate.
- Repeated-question rate.

## 17. MVP Milestones

### M0: Repo and Baseline

- Keep current `rag-service` as reference implementation.
- Add architecture docs and golden tests.
- Add one reproducible local dev command.

### M1: Chatwoot Integration

- Run Chatwoot locally.
- Create webhook receiver.
- Receive Chatwoot message events.
- Send agent replies back to Chatwoot.
- Add internal note for agent trace.

### M2: Agent Event Loop

- Add `ConversationEvent` table/store.
- Add bounded orchestrator loop.
- Add action terminality.
- Support `tool_then_continue`.

### M3: Context and Memory Split

- Split memory stores.
- Move RAG to lazy context builder.
- Add external facts provider interface.

### M4: Tools

- Product lookup.
- Media lookup.
- Availability.
- Price calculation.
- Order history.
- Handoff.
- Follow-up scheduling.

### M5: Evaluation and Ops

- Golden test suite.
- Failure case export.
- Dashboard for traces, reviews, and handoff quality.

## 18. Skills to Pull Into Development Workflow

These are development-assistant skills, not runtime customer-service skills.

### High priority

- `openai-developers:agents-sdk`: useful when comparing custom loop vs OpenAI Agents SDK concepts: tools, handoffs, sessions, guardrails, tracing.
- `superpowers:writing-plans`: useful for turning this PRD into implementation phases.
- `superpowers:subagent-driven-development`: useful for parallel analysis of Chatwoot, current rag-service, and LangGraph.
- `superpowers:systematic-debugging`: useful for integration failures across webhook, queue, and tool calls.
- `superpowers:verification-before-completion`: useful before claiming a milestone is done.

### Medium priority

- `github:github`: useful once this repo is committed or mirrored to GitHub.
- `data-analytics:build-dashboard`: useful for evaluator and ops dashboards.
- `product-design:audit`: useful for reviewing human-agent handoff UX in Chatwoot.
- `build-web-apps:frontend-testing-debugging`: useful for dashboard and test console.

### External open-source engineering aids

- Chatwoot: support inbox and handoff shell.
- LangGraph: durable stateful agent orchestration.
- Dify: reference implementation for knowledge/workflow UX, not primary runtime.
- Rasa: reference for deterministic dialogue state and correction handling.

## 19. Acceptance Criteria

MVP is acceptable when:

- A Chatwoot incoming message can trigger the agent and receive a reply.
- The agent can collect product, rental period, height, and weight across multiple turns.
- The agent can call at least one read tool and continue after the tool result.
- The agent can hand off to a human with a useful internal note.
- Small talk and confirmation do not trigger RAG.
- Image requests return actual media when media exists.
- Every reply has a trace containing intent, action, context layers, tool calls, and evidence.
- Golden regression tests pass before release.

## 20. Main Risks

- Overfitting to clothing rental while claiming generic customer service.
- Rebuilding too much helpdesk UI instead of using Chatwoot.
- Treating RAG as universal context rather than one context layer.
- Letting evaluator reports pile up without feeding back into policy/tests.
- Making tools available without risk classification and approval policy.

## 21. Recommended Decision

Proceed with:

```text
Chatwoot as support platform
+ current rag-service business logic as migration source
+ new agent sidecar with event loop, memory split, tools, and lazy context
+ optional LangGraph if durable orchestration becomes complex enough
```

Do not proceed by simply adding more skills to the current `/chat` endpoint. That path will make the system more capable superficially, but harder to control, debug, and safely hand off.
