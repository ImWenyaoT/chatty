---
name: chatty-legacy-rag-compatibility
description: Use when touching rag-service, LegacyRagServiceAdapter, answerQuestion, the legacy /chat path, legacy memory-store fallback, or old test/dashboard compatibility.
---

# Chatty Legacy RAG Compatibility

## Rules

- Treat `rag-service` as the compatibility lane, not as code to rewrite during MVP loop work.
- Prefer the existing adapter boundary before bypassing old sanitization, templates, memory behavior, or action selection.
- Build `rag-service` before expecting `apps/web` to import `dist/src/rag.js`.
- Keep legacy memory fallback readable until SQLite write paths are proven stable.

## Workflow

1. Read `rag-service/src/rag.ts`, the touched legacy module, and `apps/web/lib/legacy-adapter.ts` when relevant.
2. Decide whether the change affects only legacy behavior or also the new Chatty loop.
3. Add regression coverage in the package where behavior changes.
4. Run `npm run build:rag-service`.
5. If `apps/web` imports or wraps the legacy path, run `npm --workspace @chatty/web run build`.
6. If loop behavior changes, also use `chatty-bounded-loop-work`.

