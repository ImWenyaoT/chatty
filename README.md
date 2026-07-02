# Chatty

Chatty is a Next.js-first agentic customer-service prototype for rental commerce.

The current repository keeps the existing `rag-service` runnable while adding a gradual TypeScript/Node.js foundation for:

- bounded agent-loop orchestration;
- SQLite-backed session and trace state;
- conservative migration of existing customer/product memory;
- OpenAI Agents SDK TypeScript adapters;
- OpenAI Chat Completions compatibility and fallback adapters;
- documentation-first architecture decisions under `docs/`.

## Current Status

This is an early engineering prototype. The legacy `rag-service` remains the compatibility lane, and the new packages define the contracts needed for the next implementation phase.

## Useful Commands

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck:skeleton
pnpm build:rag-service
```

## Docs

- [Tech Stack Decisions](docs/tech-stack-decisions.md)
- [Loop Engineering Plan](docs/loop-engineering-plan.md)
- [Agentic Customer Service PRD](docs/agentic-customer-service-prd.md)

## Experiments

- `experiments/dify/`: imported Dify workflow references for product and orchestration comparison.
