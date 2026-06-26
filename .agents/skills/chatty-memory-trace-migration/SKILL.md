---
name: chatty-memory-trace-migration
description: Use when modifying SQLite repositories, session state, memory snapshots, trace persistence, JSON fallback migration, or eval/debug trace fields.
---

# Chatty Memory Trace Migration

## Rules

- SQLite MVP stores session/state and JSON-shaped memory first; do not normalize all profile fields early.
- Preserve legacy `memory-store.json` fallback until the SQLite write path is stable.
- Store evidence and debugging details in traces; do not promote transient RAG evidence into long-term customer memory by default.
- Trace rows should keep event/action/input/output/toolCalls/references when available.

## Workflow

1. Write or update `packages/db/src/*.test.ts` before repository changes.
2. Verify JSON fallback behavior still works for legacy memory snapshots.
3. Keep repository APIs small and package-local; route handlers should not write raw SQL.
4. Run `npm --workspace @rental/db run test` and `npm run typecheck:skeleton`.
5. If route persistence changes, also run `npm --workspace @chatty/web run build`.
