## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues; external pull requests are not a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The repo uses the default canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repository has one architecture context; root `CONTEXT.md` is the only entry point. See `docs/agents/domain.md`.

### Vocabulary

- Chatty's highest-order project axiom is **Agent = Model + Harness**. Use it to define the system boundary before applying any external terminology source.
- Use [OpenAI Developers](https://developers.openai.com/api/docs/guides/agents) for Agent runtime/API terms and Matt Pocock's [Dictionary of AI Coding](https://github.com/mattpocock/dictionary-of-ai-coding/tree/main/dictionary) for AI-coding terms.
- Keep established technical names and code/API identifiers in their original form; otherwise prefer plain Chinese over invented English jargon.
- Add to the Chatty glossary only when a recurring project-specific ambiguity affects architecture, behaviour, or acceptance criteria. Ordinary discussion does not need a new rule or glossary entry.

## PR instructions

- Title format: `[chatty] <Title>`
- Before committing, run the current Python and web gates: Ruff format/check, ty, pytest, deterministic eval, `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.
