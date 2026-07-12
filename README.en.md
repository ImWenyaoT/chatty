<p align="center"><strong>Chatty</strong></p>
<p align="center">A seller-side customer-service agent harness · TypeScript monorepo · DeepSeek-backed</p>
<p align="center">
  <a href="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml/badge.svg" /></a>
</p>
<p align="center"><a href="README.md">简体中文</a> | English</p>

---

`agent = model + harness`: the model is pinned to `deepseek-v4-pro`; the harness is the part that evolves. One customer-service message runs through a bounded loop — task scheduling → context assembly → model compose → output parser → policy-aware executor → trace — observable and regression-tested end to end. The live playground compose path requires a DeepSeek API key; tests and smoke checks use explicit stubs for deterministic boundaries.

## Capabilities

- **Harness loop** — deterministic task scheduling + bounded loop control; missing configuration and provider/output failures remain explicit errors instead of being disguised as successful replies.
- **Agentic retrieval** — a bounded tool loop inside compose; the model decides whether to call `search_knowledge` (SQLite FTS5 trigram + a 2-char Chinese LIKE fallback), forced to answer after at most 3 searches.
- **Policy-aware executor** — every tool call passes an allow / require_approval / deny gate; high-risk tools (e.g. refunds) never auto-execute.
- **Memory & trace** — SQLite-persisted session / trace / memory; a turn's commit and continuity memory are locked down by tests.
- **LLM observability** — compose runs DeepSeek pro through the OpenAI Agents SDK by default; each call records KV cache hit ratio and cost.
- **Golden regression** — a plain golden set under `eval/` plus an LLM judge, run with a single `pnpm eval`.

## Quickstart

```bash
pnpm install --frozen-lockfile
pnpm dev      # Next.js playground (apps/web)
pnpm test     # workspace unit tests
pnpm smoke    # core data-path smoke with test doubles
pnpm eval     # golden regression (needs a real LLM key)
```

Set `OPENAI_API_KEY` (a DeepSeek OpenAI-format key) before running the playground. Its compose step runs DeepSeek pro + the Agents SDK; the message API returns 503 when the key is absent.

## Layout

| Path | Role |
| --- | --- |
| [`packages/agent-core`](packages/agent-core) | Harness core: task scheduling, context, parser, executor, policy, agentic search |
| [`packages/llm`](packages/llm) | DeepSeek adapter (Chat Completions + Agents SDK) + usage telemetry |
| [`packages/db`](packages/db) | SQLite: session / trace / memory / knowledge (FTS5) |
| [`packages/shared`](packages/shared) | Cross-package types, schemas, quality-gate contract |
| [`apps/web`](apps/web) | Next.js playground + dashboard |
| [`eval/`](eval) | Plain golden regression (judge + golden runner + scenario YAML) |

## Quality gates

`pnpm test` / `pnpm test:fullstack` / `pnpm test:coverage` / `pnpm test:coverage:core` / `pnpm smoke` / `pnpm typecheck` / `pnpm lint` run on PRs and `main` via [CI](.github/workflows/ci.yml). The full-stack gate exercises the real Next API, SQLite, and worker seams. The real-LLM golden regression is a manual workflow ([`eval.yml`](.github/workflows/eval.yml)). The command and CI-step contract is executable documentation — see [`quality-gates.ts`](packages/shared/src/quality-gates.ts).

## Docs

- Architecture design (primary) — [docs/design.md](docs/design.md)
- Supplementary diagrams — [docs/current-architecture.md](docs/current-architecture.md)
- Tech decisions — [docs/tech-stack-decisions.md](docs/tech-stack-decisions.md)
- Development method — [docs/development-method.md](docs/development-method.md)

## Data note

This repo is open source, but the business comes from a real shop: real customer information and shop-private data are never committed, and examples use placeholders throughout (a sample rental shop / 18800000000). See [AGENTS.md](AGENTS.md) for the convention.

## License

Released under the [MIT](LICENSE) license.
