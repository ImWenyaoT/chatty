---
name: chatty-eval-loop-work
description: Use when modifying Chatty's evaluation/regression loop — evaluator bridge, trace_reviews, failure_cases, golden export, or async evaluation in route handlers. Covers PRD §10/§13/M5.
---

# Chatty Eval Loop Work

## When to use
- Adding/modifying an evaluator (packages/agent-core/src/evaluator.ts)
- Changing trace_reviews or failure_cases schema/repositories (packages/db)
- Touching the async evaluation path in apps/web route handlers
- Modifying golden export serialization (packages/agent-core/src/golden-export.ts)
- Changing the failure-score threshold or failure-case lifecycle

## Core constraints (non-negotiable)

1. **Never rewrite the evaluator.** The legacy `evaluateCustomerServiceReply()` in `rag-service/src/rag.ts:423` is the canonical scorer. agent-core wraps it behind the `Evaluator` interface via `createEvaluator()`; the wiring lives in `apps/web/lib/legacy-adapter.ts:loadLegacyEvaluator()`. If you need a different scoring strategy, add a new `Evaluator` implementation — do not fork the prompt.

2. **agent-core must not depend on packages/db.** The `FailureCaseCandidate` type (packages/agent-core/src/failure-case-policy.ts) is the agent-core-side shape; the web layer maps it onto `db.NewFailureCase` (adding an id). Keep this boundary — pure functions in agent-core return `Omit<NewFailureCase,'id'|'createdAt'>`-shaped objects.

3. **Async eval is fire-and-forget.** In the route handler, `evaluateAndRecord()` runs detached (`void ...catch()`) and never blocks the user turn or fails the request. It only runs when `sqliteEnabled` and the evaluator are both available. Do not make it await.

4. **golden-export is zero-dependency.** `exportFailureCaseToGoldenYaml()` handwrites YAML (no `yaml` package in agent-core). Its output MUST match the legacy golden schema (`rag-service/tests/golden/*.yaml`: `name/description/customerId/steps[].user/expect.{contains,notContains,minScore}`). Compare against `happy-path.yaml` before changing the format.

## Workflow
1. **Read first**: `docs/loop-engineering-plan.md §10`, `docs/agentic-customer-service-prd.md §13`, and the existing files above.
2. **TDD**: write/extend the test in the matching `*.test.ts` first (db: `db.test.ts`; agent-core: the module's test), run it red, then implement.
3. **Reuse check**: before adding scoring/extraction logic, confirm it isn't already in legacy `rag.ts` or `memory-store.ts`.
4. **Verify**: `npm --workspace @rental/db run test`, `npm --workspace @rental/agent-core run test`, `npm run typecheck:skeleton`. If you touched web: `npm --workspace @chatty/web run typecheck && npm --workspace @chatty/web run build`.

## Failure-case lifecycle
- `open` (created from low score) → `promoted` (exported to golden) OR `dismissed` (reviewed, not a regression).
- `markPromoted(id)` flips status; `dismissed` is set the same way (UPDATE status). There is no auto-archival.
- Threshold: `DEFAULT_FAILURE_SCORE_THRESHOLD = 6` (score < threshold → candidate).

## Don't
- Don't introduce promptfoo/langfuse unless the plan explicitly approves it (runtime complexity). The legacy `scripts/eval.ts` regression runner + `getReviewSummary()` aggregate are the MVP eval infra.
- Don't persist `score`/`evaluatorModel` on the `agent_traces` row itself — they live in `trace_reviews` (one-to-many, a trace may be re-evaluated).
