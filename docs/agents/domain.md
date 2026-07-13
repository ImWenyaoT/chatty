# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

This is a multi-context monorepo. Start from the map:

- **`CONTEXT-MAP.md`** at the repo root -- the entry point. It carries the shared, system-wide vocabulary and points at one `CONTEXT.md` per context (one per package/app, plus the eval and retrieval surfaces). Read the map, then the `CONTEXT.md` for each context relevant to your topic.
- **`docs/adr/`** for system-wide decisions, and **`<context>/docs/adr/`** (e.g. `packages/agent-core/docs/adr/`) for context-scoped decisions that touch the area you're about to work in.

If any of these files don't exist, continue without treating absence as an error or proposing speculative files. This instruction only suppresses expected missing-document noise; it does not permit runtime, data, or validation failures to be hidden. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-context monorepo (this repo):

```text
/
├── CONTEXT-MAP.md                          <- entry point: shared vocabulary + maps contexts -> CONTEXT.md
├── docs/adr/                               <- system-wide decisions
├── packages/
│   ├── agent-core/  (@rental/agent-core)   <- harness runtime; CONTEXT.md + docs/adr/ (lazy)
│   ├── llm/         (@rental/llm)           <- model plumbing / SDK adapter
│   ├── db/          (@rental/db)            <- SQLite harness store
│   └── shared/      (@rental/shared)        <- browser-safe API contracts
├── apps/
│   └── web/         (@chatty/web)           <- seller workspace / web demo
├── eval/                                    <- evaluation lane
└── packages/agent-core/search-execution + packages/db/knowledge-index + knowledge/ <- search / retrieval
```

Per-context `CONTEXT.md` and `docs/adr/` are created lazily by `/domain-modeling`; treat their absence as "not resolved yet", not an error.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT-MAP.md` (or the relevant per-context `CONTEXT.md`). Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal -- either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) -- but worth reopening because..._
