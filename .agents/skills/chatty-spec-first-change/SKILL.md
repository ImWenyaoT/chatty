---
name: chatty-spec-first-change
description: Use when changing Chatty architecture, package boundaries, loop behavior, runtime lanes, memory or trace semantics, or docs-backed product decisions.
---

# Chatty Spec-First Change

## Workflow

1. Read `docs/loop-engineering-plan.md`, `docs/tech-stack-decisions.md`, and the nearest source files for the target package.
2. Classify the change into one lane: `apps/web`, `packages/agent-core`, `packages/db`, `packages/llm`, `rag-service`, or `experiments`.
3. If the change alters behavior, state, architecture, or vocabulary, update docs before code.
4. Keep runtime terms stable: use `tools`, `playbooks`, `policies`, and `knowledge`; do not call product runtime concepts `skills`.
5. Add or update focused tests for the package you changed.
6. Run package-level verification first, then the smallest root-level verification that proves integration.

## Verification Map

- `apps/web`: `npm --workspace @chatty/web run typecheck`, `npm --workspace @chatty/web run build`
- `packages/agent-core`: `npm --workspace @rental/agent-core run test`, `npm run typecheck:skeleton`
- `packages/db`: `npm --workspace @rental/db run test`, `npm run typecheck:skeleton`
- `packages/llm`: `npm --workspace @rental/llm run typecheck`, `npm run typecheck:skeleton`
- `rag-service`: `npm run build:rag-service`

