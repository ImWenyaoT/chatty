# 08 — Contract the Legacy Control Plane

**What to build:** The active customer-service path uses Trace plus Durable Tasks instead of creating a heavyweight workflow run for every turn, while retaining externally observable cancellation, replay, recovery, Handoff, follow-up, and operator read behaviour.

**Blocked by:** 04 — Customer-wait Durable Task; 05 — Handoff and Follow-up as Durable Tasks; 07 — Verifiable Memory Provenance.

**Status:** wontfix for this Harness MVP

The legacy controller remains only as the compatibility floor for already-observable cross-process cancellation, idempotent replay, FIFO input, restart recovery, and operator read models. Replacing those behaviours is Web/control-plane product work and would violate the explicit preserve-behaviour boundary. Customer-facing unresolved work no longer uses its job vocabulary; it uses the new small Durable Task system.

- [x] Synchronous turns create no Customer Durable Task; legacy run/event rows remain only for observable execution-control compatibility.
- [ ] Handoff and follow-up no longer depend on legacy workflow/job states.
- [ ] Crash recovery reclaims unfinished Durable Tasks without the general lease/heartbeat/version machinery where it is unnecessary.
- [ ] Internal Memory work remains distinct from customer-facing Durable Tasks.
- [ ] Existing public API response fields and operator read models either retain their behaviour through a narrow adapter or are demonstrably internal and removed together with callers.
- [ ] Replaced tables, modules, compatibility code, and tests are removed only after no active caller remains.
