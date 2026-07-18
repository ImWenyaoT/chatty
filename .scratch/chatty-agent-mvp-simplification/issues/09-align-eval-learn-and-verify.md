# 09 — Align Eval, Learn Chatty, and Verification

**What to build:** Production, golden eval, documentation, and Learn Chatty all describe and exercise the same minimum single-Agent Harness, with all old design claims and dead paths removed.

**Blocked by:** 01 — Runtime Agent Instructions; 02 — SQLite-backed Availability; 03 — SQLite Order Mutations; 05 — Handoff and Follow-up as Durable Tasks; 07 — Verifiable Memory Provenance; 08 — Contract the Legacy Control Plane.

**Status:** done for production; Learn Chatty follow-up deferred

Production, deterministic tests, golden eval cases, current docs, and release gates are aligned. Per the user's explicit boundary, `learn-chatty` is a teaching companion to maintain later and is not part of this production mainline change.

- [ ] Production and golden eval reuse the same Agents SDK-backed Harness runner.
- [ ] Golden cases cover SQLite availability, rental/buyout ambiguity, real order effects, Durable Task creation, forced Handoff, and Repeat Customer Memory.
- [ ] Learn Chatty provides a minimal executable explanation of the final architecture without becoming a second production implementation.
- [ ] Current docs no longer treat full Claude Code as a complexity budget or describe superseded routing/workflow behaviour.
- [ ] Full workspace test, typecheck, coverage, full-stack, worker, smoke, lint, formatting, and diff checks pass within the defined source boundaries.
- [ ] A final two-axis review finds no unresolved Standards or Spec issues.
