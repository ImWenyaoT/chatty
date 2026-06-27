---
name: chatty-runtime-vocabulary
description: Use when adding or modifying Chatty runtime tools, policies, or playbooks — catalog stubs, workflow tools, policy gate, invokeWithPolicy, playbook schema/loader. Covers PRD §11/§14/§15.
---

# Chatty Runtime Vocabulary

> IMPORTANT: these are RUNTIME customer-service concepts, NOT dev workflow skills. Call them `tools`, `playbooks`, `policies`, `knowledge` — never `skills` (AGENTS.md).

## When to use
- Adding a tool to `packages/agent-core/src/tools/` (e.g. a new catalog/order/workflow/refund tool)
- Changing the policy layer (`packages/agent-core/src/policies/policy.ts`) or `invokeWithPolicy`
- Modifying the playbook schema/loader (`packages/agent-core/src/playbooks/`)
- Registering tools in `createDefaultToolRegistry()`

## Core constraints

1. **RuntimeTool<Record<string,JsonValue>,JsonValue> is the tool interface** (`packages/shared/src/types.ts`). Input is a loose JSON record (the model describes it); the tool's own `execute()` validates. Return values that use named interfaces need `as unknown as JsonValue` to satisfy the index-signature-free structural type (see order-stubs.ts).

2. **Risk drives policy, approvalRequired gates hard stops.**
   - `low` → policy allows automatically (read-only, internal note, follow-up).
   - `medium` → policy requires approval (customer-facing handoff).
   - `high` → `approvalRequired: true` AND policy requires approval; `execute()` should throw `NotImplementedError` until a real adapter exists (see refund-stub.ts).
   - `closed` session → policy denies all side effects.

3. **invoke() vs invokeWithPolicy()**. `invoke()` is the hard gate (approvalRequired throws `ApprovalRequiredError`). `invokeWithPolicy()` consults the `Policy` first — use it when the loop should respect session status / risk tiering. Don't duplicate the gate logic.

4. **Stubs are deterministic.** Tool stubs return hardcoded data (SUIT-001, ORD-1001, fixed timestamps) so tests need no DB. A later step swaps in real inventory/order/finance adapters behind the SAME `RuntimeTool` interface — keep the interface stable.

5. **Playbook loader takes a POJO, not YAML.** `loadPlaybook(obj)` validates with zod; the caller does yaml→object conversion (so agent-core has zero new deps). Don't add a `yaml` dependency to agent-core.

## Workflow
1. **Read first**: `docs/agentic-customer-service-prd.md §11` (tools), `§14` (RAG/knowledge), `packages/shared/src/types.ts` (RuntimeTool).
2. **TDD**: write the test in `tools/registry.test.ts` (or a new `*.test.ts`) first — register, invoke read-only, assert approvalRequired throws for high-risk.
3. **Register**: add the tool to `createDefaultToolRegistry()` in `tools/registry.ts` and export from `src/index.ts`.
4. **Verify**: `npm --workspace @rental/agent-core run test`, `npm run typecheck:skeleton`.

## Risk tiering cheat sheet (PRD §11)
| Tool | Risk | approvalRequired | Notes |
|------|------|------------------|-------|
| search_products, calculate_price, get_product, get_media, check_availability, get_order_history, get_order_status | low | false | read-only |
| schedule_followup, add_internal_note | low | false | write, low impact |
| create_handoff | medium | false | customer-facing escalation (policy gates) |
| issue_refund, compensation, order_modification | high | true | schema-only until real adapter; execute throws |

## Don't
- Don't implement high-risk tool execution bodies in MVP — schema + `approvalRequired:true` + `NotImplementedError` is the deliverable.
- Don't couple tools to packages/db — stubs are self-contained; real adapters will be injected, not imported.
