---
name: chatty-open-source-skill-adoption
description: Use when considering external, community, open-source, copied, forked, or upgraded skills for Chatty project workflows.
---

# Chatty Open Source Skill Adoption

## Rules

- Prefer adapting a focused workflow over copying a broad skill wholesale.
- Record provenance for every external skill idea used: source URL or package path, license, version or commit, license compatibility, required notices, and local changes.
- Keep imported workflow skills under `.agents/skills/`; do not mix them with runtime customer-service tools.
- Remove vendor-specific assumptions that do not apply to Chatty.
- If license or provenance is unclear, do not copy, paraphrase, or closely adapt the source text; write a clean-room skill from independently stated project needs.
- Preserve required copyright, attribution, and NOTICE text when the license requires it.

## Adoption Checklist

1. Identify the repeated Chatty workflow the skill should improve.
2. Inspect the source skill and license.
3. Decide: use as-is, adapt, or clean-room rewrite.
4. Keep `SKILL.md` concise and project-specific.
5. Add a `## Provenance` section for any external idea, copy, fork, or adaptation.
6. Use `chatty-subagent-grill-review` before accepting the skill.
