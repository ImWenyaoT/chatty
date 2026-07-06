# Chatty

Chatty is a seller-side agent demo for reviewing and explaining the product and technical shape of a rental customer-service assistant.

## Language

**Frontend Experience Contract**:
The automatically verified contract for visual affordances, accessibility, and interaction feedback in the web demo. It does not cover agent context, memory, multi-agent behavior, model choice, or harness orchestration.
_Avoid_: UI contract, frontend test, pixel test

**Harness**:
The agent runtime boundary that controls context, memory, multi-agent behavior, loop orchestration, tool use, and model-facing execution. Visual layout, accessibility affordances, and page-level interaction feedback are outside this boundary.
_Avoid_: frontend, UI layer, page chrome

**Demo Review**:
The primary review mode for Chatty's web experience, optimized first for the maintainer's own project recap and second for product-role and technical-role interview explanation.
_Avoid_: production launch, buyer chat, generic ChatGPT clone

**Seller Workspace**:
The web surface that lets the maintainer navigate seller-side workflows. Its minimum route set is the review entry page, the customer-service conversation page, and order operations; it must not collapse back into a single chat-only page.
_Avoid_: chat page, chatbot page, buyer chat

**Customer Service Workspace**:
The seller-facing conversation surface for handling customer questions while inspecting memory, knowledge hits, order follow-up, and trace review. It is the product-facing name for the `/playground` route; technical review may also call the same route a Harness Playground.
_Avoid_: agent console, ChatGPT clone, buyer chat

**Harness Playground**:
The technical review name for the `/playground` route when discussing trace, memory, knowledge retrieval, LLM usage, and bounded harness execution. It must remain secondary to the product-facing Customer Service Workspace language in visible navigation.
_Avoid_: product page, buyer chat, generic chatbot

**Order Operations**:
The seller workflow surface that shows how agent-assisted conversation connects to rental order follow-up. It is demo evidence for a seller workspace, not a full order-management product.
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
