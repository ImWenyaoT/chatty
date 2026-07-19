<p align="center"><strong>Chatty</strong></p>
<p align="center"><a href="README.md">简体中文</a></p>

Chatty is a customer-service Agent MVP built as a resume project. Its governing axiom is **Agent = Model + Harness**: the Model understands intent and selects Tools; the Harness supplies trusted Context, bounded Tools, real execution, SQLite persistence, Trace evidence, and completion verification. OpenAI Agents SDK owns the only Agent Loop.

The runnable path is `Next.js → FastAPI → Runner.run → SQLite`. The Model can search source-backed seller Knowledge, read or change Orders, save explicit Customer Memory with Trace provenance, and create a traceable Handoff. A plausible reply alone is never proof that business work completed.

## Run locally

Python 3.12, Node.js 24, uv, and pnpm are required.

```bash
cp .env.example .env
uv sync --locked
uv run --env-file .env python main.py
```

In another terminal:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The only Model settings are `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `MODEL_ID`. The example uses DeepSeek's OpenAI-compatible Chat Completions API with `deepseek-v4-pro`; thinking is disabled.

## Three pages

- `http://127.0.0.1:3000/playground` sends messages and shows replies, sources, and completion evidence.
- `http://127.0.0.1:3000/dashboard` shows real Agent Runs, Tools, Traces, and outcomes.
- `http://127.0.0.1:3000/orders` reads the SQLite Orders changed by the Agent.

The pages call FastAPI only. `data/chatty.sqlite` is the source of truth for Sessions, Orders, Customer Memory, Handoff receipts, and local Traces. Seller Knowledge comes from `knowledge/records.jsonl` and is imported into SQLite FTS5.

## Eval and verification

Deterministic cases live in `eval/cases.jsonl`. The controllable Model replaces only the external API; FastAPI, OpenAI Agents SDK Runner, Tools, SQLite, Tracing, and completion verification use the real Agent path.

```bash
UV_CACHE_DIR=.cache/uv uv run python -m chatty.eval
UV_CACHE_DIR=.cache/uv uv run ruff format --check .
UV_CACHE_DIR=.cache/uv uv run ruff check .
UV_CACHE_DIR=.cache/uv uv run ty check
UV_CACHE_DIR=.cache/uv uv run pytest -q
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

With explicit DeepSeek credentials, opt in to the live contract eval:

```bash
UV_CACHE_DIR=.cache/uv uv run pytest -q --run-deepseek tests/test_deepseek_contract.py
```

The contract eval never prints or persists secrets.

## Scope

This is a local resume project for demonstrating Agent/Harness boundaries, real business side effects, and verified outcomes. It is not a production customer-service or ecommerce system and makes no production availability claim. Authentication, multitenancy, payments, fulfillment, remote deployment, SLAs, multi-agent, RAG/vector databases, and streaming are out of scope.

See [`CONTEXT.md`](CONTEXT.md) for the single architecture entrypoint and [`docs/adr`](docs/adr) for decision history.

## License

[MIT](LICENSE)
