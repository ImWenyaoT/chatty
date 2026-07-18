# 07 — Verifiable Memory Provenance

**What to build:** Repeat Customer Memory distinguishes explicit customer facts from Model inference and permits promotion only with the required source evidence.

**Blocked by:** 06 — Repeat Customer Memory Gate.

**Status:** done

Completed with source Trace validation, explicit/inferred evidence, stable-only extraction, and repository promotion guards.

- [ ] Every Memory Candidate cites a valid source Trace and records whether it is explicit or inferred.
- [ ] Explicit stable customer statements may promote after Repeat Customer eligibility.
- [ ] Inferred preferences remain candidates until customer confirmation, corroborating evidence, or human approval exists.
- [ ] One-time transaction needs remain Transaction Context.
- [ ] Repository rules reject promotion that lacks eligibility or evidence even if the Model requests it.
- [ ] Relevant promoted Memory is selected on demand without vector database or RAG infrastructure.
