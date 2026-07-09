# Chatty SDK Usage Audit

## Scope

This audit checks whether Chatty's current codebase can support the two resume PDFs under `docs/` without fact drift:

- `docs/田文耀-浙江科技大学28届硕士-技术实习.pdf`
- `docs/田文耀-浙江科技大学28届硕士-产品实习.pdf`

The working rule is:

> Chatty should use OpenAI Agents SDK wherever it covers DeepSeek-compatible agent loop, tool orchestration, and model plumbing. When the Agents SDK does not cover a capability, or DeepSeek does not support the needed OpenAI surface, Chatty may fall back to the official OpenAI SDK Chat Completions API as compatible harness plumbing.

This is an audit of implementation facts and resume alignment only. It does not prescribe interview wording.

## Resume Claims

### Technical Resume

The technical resume makes the stronger SDK claim:

- Chatty is a customer-service Agent Harness for rental-commerce seller support.
- The harness covers task scheduling, context assembly, knowledge search, action parsing, tool execution, and trace recording.
- The model connects to DeepSeek.
- Tool calling is adapted through OpenAI Agents SDK.

### Product Resume

The product resume does not make a direct SDK dependency claim. It claims product and harness behavior:

- Chatty frames one customer-service turn around task completion and correctness.
- It designs task recognition, context assembly, Tool Use, risk approval, and human takeover as an evaluable Agent Loop.
- Golden scenarios and LLM judge are used for regression evaluation.
- Trace evidence is kept for task goals, action decisions, tool results, and policy reasons.

## Current Code Facts

### TypeScript and Node.js

The repo is a TypeScript / Node.js workspace:

- Root `package.json` sets `"type": "module"`.
- Root `package.json` requires Node `>=22`.
- Packages and apps are TypeScript workspaces under `packages/*` and `apps/*`.

This supports both resume variants.

### Agents SDK Is Used in the Live Chatty Runtime

The live playground compose path uses OpenAI Agents SDK:

- `apps/web/lib/llm.ts` imports `createDeepSeekAgentsSdkToolLoop`.
- `createPlaygroundModelFn()` enables the live model function when a DeepSeek key is present.
- `createAgentsSdkComposeModelFn()` wraps the compose step with `createDeepSeekAgentsSdkToolLoop`.
- `createPlaygroundLlmRuntime()` reports `mode: 'agents-sdk'` when the key is present.

The SDK adapter is explicit:

- `packages/llm/src/agents-sdk-adapter.ts` imports `Agent`, `OpenAIChatCompletionsModel`, `run`, and `tool` from `@openai/agents`.
- `createDeepSeekAgentsModelFromEnv()` wraps the DeepSeek OpenAI-format endpoint with `OpenAIChatCompletionsModel`.
- `toAgentsSdkFunctionTool()` converts Chatty runtime tools into SDK function tools.
- `createAgentsSdkToolLoopFn()` creates the SDK-backed agent loop and calls `run(agent, input, { maxTurns })`.

This supports the technical resume claim that model/tool calling is adapted through OpenAI Agents SDK.

### Search Tool Calling Goes Through SDK Function Tools

The `search_knowledge` path is SDK-backed in the live runtime:

- `apps/web/lib/llm.ts` exposes `search_knowledge` as a tool only for `answer_question` tasks.
- The exposed tool includes name, description, JSON schema parameters, approval metadata, and an `execute` callback.
- The callback routes back through `executeSearchRequest`, preserving Chatty's registry, policy gate, knowledge fragments, search trace, tool calls, and tool results.

This means the SDK owns model-side tool invocation, while Chatty Harness still owns business policy and trace evidence. That matches the current glossary boundary in `CONTEXT.md`.

## Direct Chat Completions Usage

Direct `chat.completions.create` calls still exist, but they are concentrated in non-primary or compatibility paths.

### `packages/llm/src/chat-completions-adapter.ts`

This adapter exposes:

- `complete()`
- `completeJson()`
- `completeWithTools()`

Its own file comment describes it as direct DeepSeek Chat Completions for extraction, eval, and fallback paths. It also handles DeepSeek JSON-mode edge cases and normalizes DeepSeek usage telemetry.

Audit verdict:

- Acceptable as an exception when used for JSON extraction, eval support, compatibility probes, or fallback.
- Not acceptable as a replacement for the live Chatty Agent runtime tool loop if Agents SDK can cover that path.

Current live playground compose no longer uses this direct adapter as its primary tool loop.

### `eval/judge.ts`

The evaluation judge directly calls `getClient().chat.completions.create()` with `response_format: { type: 'json_object' }`.

The inline comment gives the reason:

- DeepSeek-compatible backends do not support `json_schema` structured outputs here.
- The judge uses JSON object mode plus parser fallback to preserve scoring robustness.

Audit verdict:

- Acceptable as an exception.
- This is eval measurement plumbing, not the live customer-service Agent runtime.
- It remains official OpenAI SDK Chat Completions API usage, not a hand-rolled protocol.

### `eval/run.ts`

`eval/run.ts` imports `createChatCompletionsAdapterFromEnv()` and uses it for eval-time model calls.

Audit verdict:

- Acceptable if kept scoped to eval, deterministic fallback, or measurement support.
- If any eval path becomes a claimed product runtime path, reassess whether it should move through Agents SDK.

## Compatibility Boundary

The current compatibility table in `packages/shared/src/architecture-bounds.ts` says:

Supported:

- DeepSeek Chat Completions
- tool calls
- JSON object output
- thinking / reasoning effort
- context cache usage
- Agents SDK custom model via `OpenAIChatCompletionsModel`
- Agents SDK function tools

Adoptable by probe:

- Agents SDK sessions
- Agents SDK human-in-the-loop / interruption shape

Not assumed:

- OpenAI Responses API
- OpenAI hosted tools
- OpenAI Conversations API

This boundary is consistent with the resume PDFs. Neither resume claims Responses API, OpenAI hosted tools, OpenAI Conversations API, SDK sessions, or SDK-native tracing as production facts.

## Alignment Matrix

| Claim | Current status | Evidence | Verdict |
| --- | --- | --- | --- |
| TypeScript + Node.js project | Implemented | Root `package.json`, workspace packages | Safe |
| DeepSeek is the model lane | Implemented | `readLlmEnv()`, `deepseek-v4-pro`, DeepSeek compatibility docs | Safe |
| OpenAI Agents SDK is used | Implemented | `@openai/agents`, `OpenAIChatCompletionsModel`, SDK `Agent`, SDK `tool`, SDK `run` | Safe |
| Tool calling via Agents SDK | Implemented for live `search_knowledge` runtime | `createDeepSeekAgentsSdkToolLoop`, `toAgentsSdkFunctionTool`, `executeSdkSearchTool` | Safe |
| Chatty owns registry, policy, trace | Implemented | SDK tool callback routes through Chatty harness execution and trace mutation | Safe |
| Golden eval / LLM judge | Implemented using direct Chat Completions | `eval/judge.ts`, `eval/run.ts` | Safe as exception |
| Human-in-the-loop via SDK | Not claimed as implemented | Compatibility table marks it `adoptable_via_probe` | Do not claim as current SDK implementation |
| SDK sessions | Not claimed as implemented | Compatibility table marks it `adoptable_via_probe` | Do not claim as current SDK implementation |
| OpenAI Responses API / hosted tools / Conversations API | Not used and not assumed | Compatibility table marks them `not_assumed` | Safe |

## Real Gaps

No current gap threatens the two PDF resume claims.

The only follow-up worth tracking is hygiene, not resume correctness:

1. Keep all live Chatty Agent runtime model/tool orchestration on Agents SDK.
2. Keep direct Chat Completions calls documented as eval, extraction, compatibility, or fallback.
3. If `completeWithTools()` becomes live runtime again, either move that path back to Agents SDK or document why DeepSeek/SDK compatibility blocks it.
4. If SDK session or human-in-the-loop support is adopted later, add tests and update the compatibility table before changing resume claims.

## Final Verdict

The current codebase supports the two resume PDFs without factual drift.

The technical resume's SDK claim is valid because the live customer-service compose path uses OpenAI Agents SDK with DeepSeek via `OpenAIChatCompletionsModel`, and `search_knowledge` is exposed as an SDK function tool.

The remaining direct Chat Completions calls are acceptable exceptions because they are official OpenAI SDK usage for eval, JSON mode, extraction, telemetry, or fallback boundaries, not evidence that the live Chatty Agent runtime is bypassing the Agents SDK.
