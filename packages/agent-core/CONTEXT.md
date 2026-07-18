# Harness Runtime

The Harness Runtime turns one customer request into a bounded, observable, and verifiable business outcome.

## Language

**Customer Service Task Scheduling**:
The Model's choice of the next customer-service action from the bounded tools exposed by the Harness.
_Avoid_: Intent router, regex routing, deterministic preclassification

**Agent Instructions**:
The always-loaded rules that define how the Chatty Agent behaves, uses tools, handles risk, and proves completion. They belong to the Agent's runtime configuration rather than Memory or search results.
_Avoid_: Customer memory, knowledge document, hardcoded reply

**Durable Task**:
An unresolved customer-service goal persisted for recovery across turns, time, Handoff, or prerequisite dependencies. Work completed synchronously in one Agent loop is not a Durable Task.
_Avoid_: Tool call, trace, every customer message

**Task Completion**:
The Harness's deterministic proof that a business tool succeeded, required information was requested, or a traceable Handoff was created.
_Avoid_: Final reply, model confidence

**Handoff**:
A Durable Task containing the problem, collected context, prior actions, and status so a human can claim and resolve it. It may be selected by the Model or enforced by the Harness at a deterministic boundary.
_Avoid_: Please contact customer service, escalation message

**Model-selected Handoff**:
A Handoff chosen by the Model when customer intent or business circumstances require human judgment.
_Avoid_: Harness failure, plain escalation text

**Harness-enforced Handoff**:
A Handoff created regardless of Model preference when approval is required, safe recovery is exhausted, or the requested operation is unsupported.
_Avoid_: Model intent classification, provider error response

**Handoff Resolution**:
Trusted human judgment, authorization, or facts that resume the same Durable Task. The Chatty Agent consumes the resolution, continues any required tools, and completes the customer reply.
_Avoid_: Separate human chat, new task, untracked instruction

**Search Execution**:
A policy-gated knowledge-tool invocation whose query is chosen by the Model and whose result becomes traceable evidence.
_Avoid_: RAG pipeline, intent-based query rewrite

**MVP Business Outcome**:
A tool-produced result whose success or waiting state is verifiable and preserved by the local business system. Production SaaS integration is not required for the outcome to be real within the demo.
_Avoid_: Polished reply, production integration

**Demo Adapter**:
A bounded local business capability that performs verifiable operations against synthetic or anonymized business records while preserving the same Harness contract as a future production adapter.
_Avoid_: Fake completion, hidden mock

**Business Tool Backend**:
The bounded commerce system behind a Harness tool. For the MVP it provides conventional SQLite-backed behaviour sufficient to execute and verify the Agent's work without becoming part of the Agent architecture.
_Avoid_: Harness logic, ecommerce platform
