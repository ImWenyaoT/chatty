# Chatty

[简体中文](README.md)

Chatty is a full-stack TypeScript project. It demonstrates a verifiable single-Agent flow for research and content production.

The project follows **Agent = Model + Harness**. The Model understands the task and selects a Tool. The Harness manages identity, permissions, execution, persistence, and completion checks. A model response alone does not prove that a task is complete.

## Technology stack

- **Runtime**: Node.js 24 and a pnpm workspace
- **Web**: Next.js App Router, React, shadcn/ui, and Tailwind CSS v4
- **Agent**: TypeScript OpenAI Agents SDK
- **Data**: SQLite, FTS5, and JSONL
- **Contracts**: TypeScript strict mode and Zod

Next.js provides both pages and the HTTP entry point. The Route Handler in `apps/web` calls `@chatty/agent` directly. The project has no separate API server and no second business-logic path.

The `@chatty/agent` package contains the Agent, Harness, Tools, Session, Trace, and SQLite access code. The `@chatty/contracts` package contains the JSON contracts shared by the Web and Agent packages.

The main flow searches local Knowledge, creates a Research Artifact, creates a Content Artifact, requests human approval, and exports to a sandbox. Xiaohongshu, Douyin, and WeChat Official Account are content formats only. Chatty does not connect to these platforms.

## Run locally

Node.js 24 and pnpm 11 are required. Reuse `OPENAI_API_KEY` from the existing `.env`. You can also set `OPENAI_BASE_URL` and `MODEL_ID`. Never commit the key.

```bash
pnpm install --frozen-lockfile
pnpm --filter @chatty/agent demo
pnpm dev
```

- Web: [http://127.0.0.1:3000/workbench](http://127.0.0.1:3000/workbench)
- Agent API docs: [http://127.0.0.1:3000/api/chatty/docs](http://127.0.0.1:3000/api/chatty/docs)
- Default database: `data/chatty.sqlite`
- Set `CHATTY_DATABASE_PATH` to change the database path

## Verify the project

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm eval
pnpm test:e2e
pnpm test:deepseek
```

`pnpm eval` runs 7 repeatable Agent/Harness cases. It writes the results to `eval/results.jsonl`. One case covers the complete Runner path from Knowledge search to Research Artifact and Content Artifact.

`pnpm test:deepseek` uses the existing key to test the live model provider. It covers Tool schemas, Sessions, Traces, Knowledge sources, and recovery from missing arguments. The test does not print or store the key.

## Build, deploy, and recover

```bash
pnpm build
CHATTY_DATABASE_PATH=/absolute/path/chatty.sqlite pnpm --filter @chatty/web start
```

The production entry point is Next.js `next start`. The repository does not depend on a cloud platform. The deployment environment must support Node.js and persistent storage. Do not store the SQLite file in a temporary file system.

Back up the database before a version change:

```bash
pnpm --filter @chatty/agent backup --database ../../data/chatty.sqlite --output ../../backups/chatty.sqlite
```

Stop the Next.js process before recovery. Keep the failed database, restore a verified backup, and then check the health endpoint.

The pre-migration code revision is `1c350fc382119c52431e1f050b616e340c1df026`. If you restore this revision, also restore the SQLite backup from the same point in time. Do not let two versions write to one database.

Legacy Web routes redirect to Workbench. Legacy Orders APIs, Tools, tests, and SQLite tables remain available for compatibility and rollback. Keep a verifiable historical revision and rollback point before removing them.

This is a local MVP. It does not provide production multi-tenancy, horizontal scaling, real platform publishing, a Skill runtime, a workflow engine, or a Multi-Agent runtime.
