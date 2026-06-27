---
name: chatty-agents-sdk-wiring
description: Use when wiring or modifying the OpenAI Agents SDK lane in Chatty — createAgentsSdkRunner, dual-provider env, bounded-step maxTurns, or routing ask_info through the SDK. Covers Phase 4.
---

# Chatty Agents SDK Wiring

## When to use
- Modifying `packages/llm/src/agents-sdk-adapter.ts` (the real `createAgentsSdkRunner`)
- Changing dual-provider env config (`packages/llm/src/client-from-env.ts`)
- Routing actions through the SDK lane in `packages/agent-core/src/loop-runner.ts`
- Changing how the route handler constructs/injects the runner
- Touching the `AgentsSdk*` contracts in `packages/shared`

## Core constraints (non-negotiable)

1. **@openai/agents is imported ONLY in packages/llm.** Product code in agent-core depends on the `AgentsSdkRunner` boundary in `@rental/shared`, never on the SDK directly. This is docs tech-stack §7 (all model calls go through packages/llm adapters). Verify: no `from '@openai/agents'` outside `packages/llm/src/`.

2. **Bounded-step preservation (docs §5.1).** The SDK runner MUST cap its internal loop with `maxTurns` (default 3) so a single request never runs an unbounded agent loop. The Chatty loop calls `runner.run()` once per request step; do not call it in a loop.

3. **Feature-flagged, never default.** The SDK lane is opt-in via `CHATTY_AGENTS_SDK=1` in the route handler. When unset, `ask_info` falls back to legacy/LLM path. Do not make the SDK runner the default path until the dual-provider runtime is validated end-to-end.

4. **Dual-provider config.** `readAgentsSdkEnv()` falls back to the shared `OPENAI_*`/`CHAT_MODEL` when `OPENAI_AGENTS_*` are unset — so a single provider still works in dev. The SDK lane can target a different endpoint (real OpenAI) while classification/eval stay cheaper. `CHAT_MODEL` default is `deepseek-chat` (unified with .env.example).

## Action routing
- `useAgentsSdkFor` defaults to `['ask_info']` — the only action that needs tool/handoff loop semantics.
- `small_talk`/`provide_info`/`handoff` NEVER go through the SDK lane (they don't need tool chaining; classification runs before routing so it can't use the SDK itself).
- To add an action: add it to `useAgentsSdkFor` AND confirm the SDK's tool set supports it.

## Workflow
1. **Read first**: `docs/loop-engineering-plan.md §5.1/§5.2` and `packages/llm/src/agents-sdk-adapter.ts`.
2. **TDD**: the real SDK path is tested via `createAgentsSdkRunnerFromFunction()` (injectable). Add type-level coverage via `typecheck:skeleton`. Do NOT write tests that call the real OpenAI API.
3. **Version check**: before changing SDK usage, confirm `@openai/agents` version (`npm view @openai/agents version`) — the API (`Agent/run/tool/handoff/lastAgent/finalOutput`) drifted across 0.x.
4. **Verify**: `npm --workspace @rental/llm run test`, `npm run typecheck:skeleton`. If you touched loop-runner: `npm --workspace @rental/agent-core run test`.

## SDK output → AgentStepResult mapping
- `result.finalOutput` (string) → `reply`.
- `result.lastAgent.name !== agentName` → `terminality: 'handoff_and_wait'`, `nextStatus: 'waiting_for_human'`.
- Otherwise → `terminality: 'reply_and_wait'`, `nextStatus: 'waiting_for_user'`.

## Don't
- Don't enable SDK tracing export in MVP (the runner sets `tracingDisabled` implicitly by not configuring trace export; local runs should stay local).
- Don't assume non-OpenAI endpoints (DeepSeek) support every SDK feature — tool-calling is the baseline assumption; handoff/tracing may not work off a real OpenAI endpoint.
