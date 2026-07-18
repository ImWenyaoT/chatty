import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleChattyAgentInstructions,
  loadChattyAgentInstructions,
} from "./agent-instructions.js";

test("runtime Agent Instructions assemble the five always-on concerns in stable order", () => {
  const instructions = loadChattyAgentInstructions();

  assert.deepEqual(
    [...instructions.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ["Identity", "Tool Discipline", "Safety", "Handoff", "Task Completion"],
  );
  assert.match(instructions, /Chatty/);
  assert.match(instructions, /必须调用/);
  assert.match(instructions, /不得编造/);
  assert.match(instructions, /create_handoff/);
  assert.match(instructions, /工具结果/);
});

test("runtime instructions reject missing or reordered stable sections", () => {
  assert.throws(
    () =>
      assembleChattyAgentInstructions(`
## Identity
identity

## Safety
safety
`),
    /expected sections in order/,
  );
});

test("customer runtime instructions never include repository development-agent rules", () => {
  const instructions = loadChattyAgentInstructions();

  assert.doesNotMatch(instructions, /Issue tracker|PR instructions|pnpm lint/);
});
