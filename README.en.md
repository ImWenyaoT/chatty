<p align="center"><strong>Chatty</strong></p>
<p align="center">A single-agent harness for seller-side customer service · TypeScript / Node.js · DeepSeek-backed</p>
<p align="center">
  <a href="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml/badge.svg" /></a>
</p>
<p align="center"><a href="README.md">简体中文</a> | English</p>

---

`agent = model + harness`: the model is pinned to `deepseek-v4-pro`; the harness is the part that evolves. One customer-service message runs through a bounded loop — task scheduling → context preparation → Agents SDK tool round → policy-gated execution → tool-free final run → trace — observable and regression-tested end to end. The live playground path requires a DeepSeek API key; tests and smoke checks use explicit stubs for deterministic boundaries.

## Capabilities

- **Harness loop** — deterministic task scheduling + bounded loop control; missing configuration and provider/output failures remain explicit errors instead of being disguised as successful replies.
- **Agentic retrieval** — each scheduled task exposes only its required tools; one bounded tool phase can call `search_knowledge` (SQLite FTS5 trigram + a 2-char Chinese LIKE fallback), followed by a tool-free SDK run grounded in that evidence.
- **Policy-aware executor** — every tool call passes an allow / require_approval / deny gate; high-risk tools (e.g. refunds) never auto-execute.
- **Memory & trace** — SQLite-persisted session / trace / memory; a turn's commit and continuity memory are locked down by tests.
- **LLM observability** — production calls use DeepSeek pro through the OpenAI Agents SDK Chat Completions model; each call records KV cache hit ratio and cost.
- **Golden regression** — a plain golden set under `eval/` plus an LLM judge, run with a single `pnpm eval`.

## Architecture

The monorepo is layered: `apps/web` is only presentation + HTTP adapters; the real value lives in the `agent-core` harness, and both the model and persistence are replaceable dependencies.

```mermaid
flowchart TD
  web["apps/web · Next.js<br/>playground + dashboard + /api"]
  core["packages/agent-core · Harness<br/>deterministic scheduling · context assembly/compaction · bounded loop · run policy · tools · agentic search"]
  llm["packages/llm<br/>DeepSeek ⇄ OpenAI Agents SDK · usage telemetry"]
  db[("packages/db · SQLite<br/>session · trace · transaction-scoped memory · FTS5 knowledge")]
  shared["packages/shared · contracts / schemas / browser-safe types"]
  worker["scripts/worker · background jobs<br/>scheduled follow-ups · memory extraction/consolidation"]
  eval["eval/ · golden regression + LLM judge"]
  deepseek(("DeepSeek API"))

  web --> core
  core --> llm --> deepseek
  core --> db
  worker --> core
  worker --> db
  eval --> core
  web -. contracts .-> shared
  core -. contracts .-> shared
```

One customer-service message = one bounded closed loop. The harness owns the task boundary, context, and tools; the model only chooses the next step inside the scheduled task:

```mermaid
sequenceDiagram
  autonumber
  participant U as Customer message
  participant H as Harness (agent-core)
  participant M as Model (DeepSeek·Agents SDK)
  participant T as Tools + Policy
  participant D as SQLite

  U->>H: one customer-service message
  H->>H: deterministic task scheduling (task + tool subset)
  H->>D: read memory / checkpoint
  H->>H: assemble context (compact to a checkpoint if over budget)
  H->>M: tool-phase run (bounded turns)
  M->>T: request search_knowledge
  T->>T: run policy gate: allow / require_approval / deny
  T->>D: FTS5 knowledge search
  T-->>M: evidence (three-part plain text)
  M-->>H: tool result
  H->>M: tool-free final run (grounded in evidence)
  M-->>H: final reply
  H->>D: append trace + continuity memory + update session
  H-->>U: reply + observable harnessTrace
```

## Quickstart

```bash
pnpm install --frozen-lockfile
pnpm dev      # Next.js playground (apps/web)
pnpm test     # workspace unit tests
pnpm smoke    # core data-path smoke with test doubles
pnpm eval     # golden regression (needs a real LLM key)
```

Set `OPENAI_API_KEY` (a DeepSeek OpenAI-format key) before running the playground. Model calls use DeepSeek pro through the Agents SDK; the message API returns 503 when the key is absent. By default, `pnpm dev` persists sessions, traces, memory, and conversation history to `data/chatty.sqlite`; set `CHATTY_DB_PATH` to override it.

## Layout

| Path | Role |
| --- | --- |
| [`packages/agent-core`](packages/agent-core) | Harness core: task scheduling, context, run policy, tool execution, agentic search |
| [`packages/llm`](packages/llm) | Agents SDK adapter for the DeepSeek Chat Completions model + usage telemetry |
| [`packages/db`](packages/db) | SQLite: session / trace / memory / knowledge (FTS5) |
| [`packages/shared`](packages/shared) | Cross-package types, schemas, and browser-safe contracts |
| [`apps/web`](apps/web) | Next.js playground + dashboard |
| [`eval/`](eval) | Plain golden regression (judge + golden runner + scenario YAML) |

## Quality gates

`pnpm test` / `pnpm test:fullstack` / `pnpm test:coverage` / `pnpm test:coverage:core` / `pnpm smoke` / `pnpm typecheck` / `pnpm lint` run on PRs and `main` via [CI](.github/workflows/ci.yml). The full-stack gate exercises the real Next API, SQLite, and worker seams. The real-LLM golden regression is a manual workflow ([`eval.yml`](.github/workflows/eval.yml)). Root [`package.json`](package.json) is the command source of truth, and CI tests verify that the workflow remains wired to those scripts.

Pushing a `v*` tag triggers the [Release workflow](.github/workflows/release.yml): it builds and starts the standalone Next.js server, probes `/api/health` with SQLite pointed at a persistent path, then publishes a runnable GitHub Release archive. A deployment target only needs Node.js 24 and `CHATTY_DB_PATH` mounted on durable storage.

## Data note

This repo is open source, but the business comes from a real shop: real customer information and shop-private data are never committed, and examples use placeholders throughout (a sample rental shop / 18800000000). See [AGENTS.md](AGENTS.md) for the convention.

## License

Released under the [MIT](LICENSE) license.
