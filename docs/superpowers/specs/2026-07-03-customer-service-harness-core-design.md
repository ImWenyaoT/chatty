# Customer-Service Harness Core Design

## Goal

Refactor Chatty around a customer-service Agent Harness core instead of a generic agent runtime or a full customer-support platform.

## Scope

Phase 1 builds a small, typed harness core inside `@rental/agent-core`:

- Schedule the next customer-service task from a user turn and memory snapshot.
- Build explicit prompt context from event, memory, product/order hints, and scheduled task.
- Parse model/tool decisions into typed customer-service actions.
- Execute allowed customer-service tools through the existing `ToolRegistry`.
- Return a trace object that shows task, context fragments, parsed action, tool calls, terminality, and memory patch.

This phase does not introduce terminal/file tools, MCP, background workers, multi-agent routing, or a new GUI. Those stay as later customer-service extensions.

## Architecture

The new module is `packages/agent-core/src/customer-harness.ts`. It uses existing shared contracts and existing runtime tools rather than creating another runtime stack.

Core pieces:

- `scheduleCustomerServiceTask(input)` maps a turn to a task: `collect_missing_info`, `answer_question`, `check_availability`, `handoff`, or `follow_up`.
- `buildCustomerServiceContext(input)` creates ordered context fragments for prompt construction and trace inspection.
- `parseCustomerServiceOutput(raw)` validates a model decision into a typed action with deterministic fallback behavior.
- `executeCustomerServiceAction(input)` runs the tool-backed action through `ToolRegistry` and maps safety outcomes to terminality.
- `runCustomerServiceHarnessStep(input)` composes the above into a single bounded step.

## Testing

Tests live in `packages/agent-core/src/customer-harness.test.ts`. They pin behavior for task scheduling, prompt context ordering, parser fallback, policy-gated tool execution, and end-to-end trace shape.

