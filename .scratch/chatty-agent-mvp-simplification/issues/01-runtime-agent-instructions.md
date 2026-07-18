# 01 — Runtime Agent Instructions

**What to build:** Chatty loads its own always-on customer-agent operating rules as runtime Agent Instructions assembled from stable sections, while keeping repository development-agent instructions, Knowledge Base, and Customer Memory separate.

**Blocked by:** None — can start immediately.

**Status:** done

Completed through the shared `agent-instructions` artifact and SDK-runner tests.

- [ ] The production and eval Agent use the same runtime instructions artifact.
- [ ] Identity, tool discipline, safety, Handoff, and Task Completion rules are always loaded.
- [ ] Repository development `AGENTS.md` content is not injected into customer conversations.
- [ ] OpenAI Agents SDK still owns the only model/tool loop.
- [ ] Deterministic tests prove instructions remain stable through a tool round.
