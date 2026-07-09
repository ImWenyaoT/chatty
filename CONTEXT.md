# Chatty

Chatty is a seller-side agent workspace for reviewing and explaining the product and technical shape of a rental customer-service assistant.

## Language

**Chatty Agent**:
The customer-service agent formed by DeepSeek as the model and Chatty Harness as the harness. The web workspace demonstrates and reviews this agent, but the agent itself is the model-plus-harness runtime boundary.
_Avoid_: frontend product, chat UI, standalone DeepSeek call

**Chatty Project Narrative**:
The interview story that explains Chatty from the resume without assuming the interviewer can inspect the code or product live. It should make the model-plus-harness boundary, harness loop, tool calling, and evaluation evidence understandable through spoken project explanation.
_Avoid_: code walkthrough, UI demo script, JD-specific pitch

**Engineering Agent Harness Project**:
The intended interview framing for Chatty: an engineering project that uses a concrete rental customer-service scenario to build and validate an Agent Harness around DeepSeek. It should not be framed primarily as a product prototype, business automation case, or AI application demo.
_Avoid_: product prototype, business automation project, AI app demo

**Sanitized Chatty Origin**:
The public interview origin for Chatty: it came from exploring whether agent-style automation could connect seller-side customer-service conversations with fulfillment follow-up across fragmented commerce tools. Specific platform names, scraping details, and policy-sensitive automation tactics should stay out of public project narration.
_Avoid_: platform names, scraping story, ToS-sensitive automation

**Balanced Chatty Introduction**:
The spoken interview introduction for Chatty that starts from rental customer-service needs and business flow before naming the harness mechanics. It should translate parser, executor, loop control, and tool calling into product-and-engineering language instead of listing internal modules first.
_Avoid_: architecture dump, module checklist, pure product pitch

**Agent Not Chatbot**:
The interview distinction that Chatty is an agent because it plans and executes bounded task flow through harness-controlled context, tools, policy, trace, and evaluation. It should not be introduced as a chatbot that only generates customer-service replies.
_Avoid_: chatbot, FAQ bot, customer-service chat box

**Agent Not Workflow**:
The interview distinction that Chatty is an agent because the model participates in deciding the next task, needed context, and tool/action path inside harness boundaries. A workflow is a useful implementation scaffold for stable steps, but it does not by itself handle open-ended customer input, uncertain task routing, or model-informed action selection.
_Avoid_: fixed workflow, form wizard, deterministic automation

**Long-Horizon Chatty Explanation**:
The interview explanation path for Chatty that moves from motivation and problem framing through architecture design, module boundaries, workflow design, trade-offs, and agent know-how. It should avoid line-level code detail unless asked, and should keep the discussion centered on how the agent is shaped by the harness.
_Avoid_: code walkthrough, feature list, shallow demo recap

**Frontend Experience Contract**:
The automatically verified contract for visual affordances, accessibility, and interaction feedback in the web demo. It does not cover agent context, memory, multi-agent behavior, model choice, or harness orchestration.
_Avoid_: UI contract, frontend test, pixel test

**Harness**:
The agent runtime boundary that controls context, memory, multi-agent behavior, loop orchestration, tool use, and model-facing execution. Visual layout, accessibility affordances, and page-level interaction feedback are outside this boundary.
_Avoid_: frontend, UI layer, page chrome

**Chatty Harness**:
The harness that turns DeepSeek into the Chatty Agent by owning task scheduling, loop and flow control, prompt input assembly, output parsing, executor dispatch, and tool calling. It is the irreducible runtime value of Chatty, not a thin prompt wrapper.
_Avoid_: prompt template, workflow mock, model wrapper

**Agents SDK Adapter Boundary**:
The integration boundary where OpenAI Agents SDK provides generic model/tool-loop plumbing for DeepSeek's OpenAI-format endpoint, while Chatty Harness keeps ownership of business task scheduling, prompt context, runtime tool registry, policy, memory, trace, and evaluation. The SDK is a replaceable runtime dependency, not the product's agent architecture.
_Avoid_: SDK-owned business logic, OpenAI-only architecture, self-built protocol loop

**OpenAI SDK First With DeepSeek Compatibility**:
The implementation preference that Chatty should use OpenAI Agents SDK wherever it covers DeepSeek-compatible agent loop, tool orchestration, and model plumbing, while keeping already-submitted resume claims stable. When the Agents SDK does not cover a capability, or DeepSeek does not support the needed OpenAI surface, Chatty may fall back to the official OpenAI SDK Chat Completions API as compatible harness plumbing. Only when neither official SDK path fits should Chatty choose one upper-bound reference from OpenClaw, Codex, or Claude Code.
_Avoid_: hand-rolled SDK-compatible protocol by default, SDK avoidance, resume-drifting rewrite, treating every direct Chat Completions call as a failure, three-reference choice before SDK check

**Deterministic Task Scheduling**:
The current Chatty Harness scheduling strategy where the harness, not the model, chooses the bounded customer-service task before composition. It is a Codex-inspired task-to-runner boundary adapted down to customer-service turns: the model may shape wording and action details later, but it must operate inside the scheduled task boundary.
_Avoid_: model-planned task routing, free-form intent routing

**Tool Calling**:
The Chatty Harness capability that lets the agent request bounded business tools and receive auditable results under policy control. It is part of the agent runtime, not a frontend interaction pattern.
_Avoid_: button action, UI plugin, arbitrary function call

**Seller Workspace**:
The web surface that lets the maintainer navigate seller-side workflows. Its minimum route set is the review entry page, the customer-service conversation page, and order operations; it must not collapse back into a single chat-only page.
_Avoid_: chat page, chatbot page, buyer chat

**Customer Service Workspace**:
The seller-facing conversation surface for handling customer questions while inspecting memory, knowledge hits, order follow-up, and trace review. The current route path is `/playground` for compatibility, but the product concept is the customer-service workspace.
_Avoid_: agent console, ChatGPT clone, buyer chat

**Customer Service Turn**:
One seller-side agent turn that receives parsed customer input, loads session and memory, runs the harness, records trace evidence, updates session state, and writes continuity memory for the next turn.
_Avoid_: demo step, route handler, playground logic

**Order Operations**:
The seller workflow surface that shows how agent-assisted conversation connects to rental order follow-up. It is workspace evidence for the order side of customer service, not a full order-management product.
_Avoid_: order system, ERP, generic admin table

**Review Dashboard**:
The optional recap surface for explaining trace review, knowledge coverage, and agent behavior after a demo run. It is not part of the minimum seller workspace and should not be treated as a full operations dashboard.
_Avoid_: backend dashboard, BI dashboard, admin console

**Reference-Bound Development**:
The engineering method for keeping Chatty between the lower bound of `docs/jd.md` and the upper bound of `openclaw`, `codex`, and `claude-code`. Each capability chooses one primary reference before implementation.
_Avoid_: generic inspiration, mixed reference soup, rewrite without bounds

**Building-Block Reproduction**:
The debugging method for shrinking a failure to the smallest observable block before composing it back into the full harness or web demo. The smallest failing block should become an automated regression when it is deterministic.
_Avoid_: full-demo guessing, manual-only verification

**Search Execution**:
The harness-owned module that turns an agent search request into model-visible output plus optional trace and context evidence. It owns query refinement, duplicate prevention, policy gating, and audited knowledge evidence.
_Avoid_: retrieval pipeline, RAG step, SDK search adapter

**Agentic Search Over RAG Pipeline**:
The Chatty stance that retrieval should be exposed as a bounded agent tool over well-indexed, summarized content and memory, not hidden inside an automatic RAG answer pipeline. The model is trusted to reason within harness boundaries; the harness owns memory quality, chunking, indexing, summarization, search tools, and trace evidence.
_Avoid_: RAG pipeline, automatic retrieval answer, vector database as agent

**Transaction-Scoped Memory**:
The Chatty memory stance that seller-side customer-service memory should preserve the recent transaction context needed to finish the current rental task, not a social-IM style long relationship history. Older facts should be promoted only when they affect future transaction handling, such as reusable body profile or stable preference.
_Avoid_: full chat archive, social relationship memory, automatic long-term memory

**SQLite Harness Store**:
The MVP persistence choice for Chatty sessions, transaction-scoped memory, traces, trace reviews, and FTS5 knowledge indexing. It is a lightweight single-process harness store for validation and eval, not the claimed final database for multi-tenant production.
_Avoid_: production database claim, distributed state store, cache-only storage
