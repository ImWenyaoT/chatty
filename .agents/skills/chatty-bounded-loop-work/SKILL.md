---
name: chatty-bounded-loop-work
description: Use when implementing or modifying Chatty agent loop contracts, terminality, handoff, tool continuation, or route handlers that call the loop.
---

# Chatty Bounded Loop Work

## Constraints

- A Next.js request handler runs one bounded step; it must not run an unbounded conversation loop.
- Preserve terminality semantics: `reply_and_wait`, `tool_then_continue`, `schedule_and_wait`, `handoff_and_wait`, and `close`.
- `small_talk` and `provide_info` should not trigger RAG.
- `ask_info` is the path that may consult legacy RAG, tools, or LLM fallback.
- Handoff results must expose enough context for a human agent through trace or memory patch.

## Workflow

1. Write or update `packages/agent-core/src/*.test.ts` for the behavior first.
2. Verify the new test fails for the expected reason.
3. Implement the smallest loop change that passes.
4. Keep `agent-core` dependent on `packages/llm` interfaces, not SDK internals.
5. Verify with `npm --workspace @rental/agent-core run test` and `npm run typecheck:skeleton`.
6. If a route handler is touched, also run `npm --workspace @chatty/web run build`.

