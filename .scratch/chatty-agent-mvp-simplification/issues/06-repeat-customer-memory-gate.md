# 06 — Repeat Customer Memory Gate

**What to build:** Long-term Customer Memory activates only after the customer's second confirmed order; before that, conversations remain Transaction Context and Trace.

**Blocked by:** 03 — SQLite Order Mutations.

**Status:** done

Completed with a persisted confirmed-order count gate at context injection and extraction scheduling.

- [ ] Zero or one confirmed order schedules no long-term extraction and injects no promoted Long-term Customer Memory.
- [ ] A second confirmed order makes the customer eligible without treating consultations or pending orders as transactions.
- [ ] Eligibility can bootstrap source evidence from that customer's prior Trace history.
- [ ] Transaction Context remains available for current work regardless of eligibility.
- [ ] The gate is enforced deterministically by persisted order state, not Model claims.
