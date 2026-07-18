# 05 — Handoff and Follow-up as Durable Tasks

**What to build:** Model-selected escalation, Harness-enforced escalation, and delayed follow-up all use the same Durable Task system and resume the same Chatty Agent loop.

**Blocked by:** 04 — Customer-wait Durable Task.

**Status:** done

Completed with Model-selected and Harness-enforced Handoff, same-task human resume, and exactly-once due-task delivery.

- [ ] Model-selected Handoff creates a task waiting for a human with problem, context, and prior actions.
- [ ] Required approval, unsupported operations, and exhausted safe recovery force the same Handoff shape.
- [ ] A human resolution resumes the original task and same Agent, which may continue using tools before replying.
- [ ] A scheduled follow-up creates a task waiting for time and is delivered exactly once when due.
- [ ] Cancellation and idempotent replay remain externally observable and correct.
- [ ] Plain “请联系人工客服” without a persisted task cannot be reported as completion.
