---
name: chatty-subagent-grill-review
description: Use when Chatty work is non-trivial, near completion, risky, delegated to sub-agents, or making claims about correctness, scope, or readiness.
---

# Chatty Subagent Grill Review

## Purpose

Use an independent sub-agent to challenge the controller's assumptions before the work is called done.

## Rules

- Keep collaboration tree-shaped: sub-agents report only to the controller.
- Only the controller starts a grill reviewer.
- A grill reviewer must not spawn sub-agents, contact other sub-agents, or ask other agents to gather evidence.
- Ask the reviewer to find blockers, weak evidence, missed tests, scope drift, and overconfident claims.
- Give the reviewer concrete artifacts: files changed, commands run, known risks, and the intended acceptance criteria.
- Do not ask the reviewer to reimplement the work.
- The controller decides and integrates; unresolved P0/P1 findings block completion.
- Do not recursively grill the grill-review process itself unless changing this skill's rules.

## Prompt Shape

```text
You are a read-only grill reviewer for Chatty. Do not edit files. Do not contact other sub-agents.
Review: [scope]
Artifacts: [files, commands, outputs]
Challenge assumptions around correctness, CI, cross-platform behavior, tests, docs, and scope.
Return findings by severity. If no blockers, say so and list residual risks.
```
