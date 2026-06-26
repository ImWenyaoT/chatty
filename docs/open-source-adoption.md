# Open-Source Adoption Decisions

> Per AGENTS.md: external/open-source/coped skills and dependencies must record
> source, license, compatibility, and local modifications. This file is the
> changelog for adoption decisions. Update it whenever a dependency or skill is
> adopted, upgraded, or rejected.

## 2026-06-26 — Eval loop & Agents SDK adoption sweep

Investigated for the WF1 (eval loop) / WF2 (Agents SDK) / WF3 (tools) workstreams.

### Adopted (as dependency)

| Package | Version | License | Source | Status | Notes |
|---------|---------|---------|--------|--------|-------|
| `@openai/agents` | 0.12.0 | MIT | npm (OpenAI official TS SDK) | Adopted | Already in `packages/llm` deps. Real adapter implemented in `agents-sdk-adapter.ts`. API surface used: `Agent`, `run`, `tool`, `result.finalOutput`, `result.lastAgent`. Validated 0.12.0 is the current published line. |
| `openai` | ^6.45.0 | MIT | npm | Adopted (existing) | Dual-provider client construction in `client-from-env.ts`. |
| `zod` | ^4.4.3 (workspace) | MIT | npm | Adopted (existing) | Playbook schema + agentsSdkRunInputSchema validation. |
| `better-sqlite3` | (existing) | MIT | npm | Adopted (existing) | SQLite repositories. |

### Investigated, NOT adopted (with rationale)

| Package | Version | License | Decision | Rationale |
|---------|---------|---------|----------|-----------|
| `promptfoo` | 0.121.x | MIT | Not adopted | Mature eval/golden runner, BUT Chatty's golden YAML schema is a custom customer-service format (`steps[].expect.{contains,notContains,action,stage,profile,minScore}`). promptfoo's own assertion format would require a translation layer. Legacy `rag-service/scripts/eval.ts` already implements golden running + baseline regression diff natively against this schema. Adopting promptfoo would duplicate working infra. Revisit only if cross-prompt/model matrix testing is needed beyond what `eval.ts` provides. |
| `langfuse` | 3.38.x | MIT | Not adopted (M5 candidate) | Open-source trace observability + eval storage. Requires a self-hosted server (docker compose) for local runs — runtime complexity too high for MVP. Legacy `getReviewSummary()` already provides an aggregate scoreboard (avgScore/lowScoreCount/topIssues). Revisit as an M5 observability enhancement once the trace→review→failure_case loop is stable. |
| `@xstate/fsm` | 2.1.0 | MIT | Not adopted | Lightweight state machine for playbook orchestration. Business flows (size consultation, refund escalation) are bespoke enough that a generic DSL adds indirection without reuse benefit. Playbook is a declarative zod-validated POJO; an execution engine (if ever needed) will be hand-written to match Chatty's bounded-step semantics. |
| `yaml` (for playbook loader) | 2.8.3 (already in rag-service) | ISC | Not added to agent-core | `loadPlaybook()` accepts a parsed object, not a YAML string, so agent-core stays dependency-free. The caller (web/CLI) does yaml→object conversion reusing the workspace-hoisted `yaml` package. |

### Adopted as project skills (`.agents/skills/`)

These are project-authored skills (not external copies), so provenance is internal:

| Skill | Source | Derived from |
|-------|--------|--------------|
| `chatty-eval-loop-work` | Internal | WF1 implementation patterns |
| `chatty-agents-sdk-wiring` | Internal | WF2 implementation patterns |
| `chatty-runtime-vocabulary` | Internal | WF3 implementation patterns |

No external/community skills were copied or forked in this sweep. If an external skill is adopted later, record it here with upstream URL, commit/license, and local modifications.

## Reuse principle enforced

The single most important reuse decision: **the legacy evaluator (`evaluateCustomerServiceReply`) and golden runner (`scripts/eval.ts`) are reused, not rewritten.** agent-core's `Evaluator` interface is a thin injection boundary around them; the web layer bridges via `loadLegacyEvaluator()`. No scoring logic was forked.
