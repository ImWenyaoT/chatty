# 04 — Customer-wait Durable Task

**What to build:** Work that cannot finish because customer information is missing becomes one recoverable SQLite Durable Task, while synchronous work creates no task and leaves only Trace.

**Blocked by:** None — can start immediately.

**Status:** done

Completed through the SQLite Durable Task repository and the restart-safe public customer-turn seam.

- [ ] The Durable Task lifecycle and prerequisite checks start from `learn-claude-code` s12 rather than the existing general workflow engine.
- [ ] A synchronous reply, search, or availability check creates no Durable Task.
- [ ] Missing required information creates one task waiting for the customer with original context preserved.
- [ ] The next relevant customer message resumes the same task rather than creating a duplicate.
- [ ] A blocked task cannot start until its prerequisites are completed.
- [ ] Completion requires persisted business or human evidence; Model text alone is rejected.
- [ ] Restarting with the same SQLite database preserves and resumes the task.
