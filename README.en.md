# Chatty

[简体中文](README.md)

Chatty is a Python/FastAPI backend with a Vite/React frontend. It demonstrates a verifiable single-Agent flow for research and content production.

The project follows **Agent = Model + Harness**. The Model understands the task and selects a Tool. The Harness manages identity, permissions, execution, persistence, and completion checks. A model response alone does not prove that a task is complete.

## Technology stack

- **Backend**: Python 3.12, FastAPI, and the uv toolchain
- **Agent**: Python OpenAI Agents SDK
- **Frontend**: Vite, React, shadcn/ui, and Tailwind CSS v4
- **Data**: SQLite, FTS5, and JSONL
- **Contracts**: Pydantic models + OpenAPI; the frontend keeps a local zod validation copy

FastAPI is the only HTTP process and serves every `/api/chatty` endpoint. `src/chatty` contains the Agent, Harness, Tools, Artifacts, Session, Trace, and SQLite access code. `apps/web` is a Vite SPA that only renders the UI and has no second business-logic path.

The main flow searches local Knowledge, creates a Research Artifact, creates a Content Artifact, requests human approval, and exports to a sandbox. Xiaohongshu, Douyin, and WeChat Official Account are content formats only. Chatty does not connect to these platforms.

## Run locally

uv, Node.js 24, and pnpm 11 are required. Reuse `OPENAI_API_KEY` from the existing `.env`: `pnpm dev:api` and the smoke entry point load the repo-root `.env` automatically on startup (existing environment variables take precedence, so production can still export real variables). You can also set `OPENAI_BASE_URL` and `MODEL_ID`. Never commit the key.

```bash
uv sync
pnpm install --frozen-lockfile
pnpm dev:api   # FastAPI at 127.0.0.1:8000
pnpm dev       # Vite dev server at 127.0.0.1:3000, proxying /api/chatty to FastAPI
```

- Web: [http://127.0.0.1:3000/workbench](http://127.0.0.1:3000/workbench)
- Agent API docs: [http://127.0.0.1:8000/api/chatty/docs](http://127.0.0.1:8000/api/chatty/docs)
- Default database: `data/chatty.sqlite`
- Set `CHATTY_DATABASE_PATH` to change the database path (relative paths resolve from the repo root)

## Verify the project

```bash
pnpm lint        # uv run ruff check . + frontend eslint/prettier
pnpm test        # uv run pytest -q + the frontend contract test
pnpm typecheck   # uv run ty check + tsc
pnpm build       # vite build
pnpm eval        # uv run python -m chatty.eval
pnpm test:e2e    # Playwright (starts the FastAPI smoke backend and the Vite dev server)
pnpm test:deepseek
```

`pnpm eval` runs 7 repeatable Agent/Harness cases. It writes the results to `eval/results.jsonl`. One case covers the complete Runner path from Knowledge search to Research Artifact and Content Artifact.

`pnpm test:deepseek` uses the existing key to test the live model provider (`uv run pytest -m deepseek`; the default test run skips these cases). It covers Tool schemas, Sessions, Traces, Knowledge sources, and recovery from missing arguments. The test does not print or store the key.

## Build, deploy, and recover

```bash
pnpm build
CHATTY_DATABASE_PATH=/absolute/path/chatty.sqlite CHATTY_STATIC_DIR=apps/web/dist \
  uv run uvicorn --factory chatty.smoke:create_smoke_app --host 127.0.0.1 --port 8000
```

The production entry point is a single FastAPI process that serves both `apps/web/dist` and `/api/chatty/*` from one origin. The repository does not depend on a cloud platform. The deployment environment must support Python and persistent storage. Do not store the SQLite file in a temporary file system.

Back up the database before a version change:

```bash
uv run python -m chatty.backup --database data/chatty.sqlite --output backups/chatty.sqlite
```

Stop the FastAPI process before recovery. Keep the failed database, restore a verified backup, and then check the health endpoint.

The rollback boundary is the last TypeScript revision before its removal, `991c111d41db96eae4e4ac4e5ee65f385829fb39` (see ADR 0014). If you restore that revision, also restore the SQLite backup from the same point in time. Do not let two versions write to one database.

This is a local MVP. It does not provide production multi-tenancy, horizontal scaling, real platform publishing, a Skill runtime, a workflow engine, or a Multi-Agent runtime.
