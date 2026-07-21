import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_INSTRUCTIONS } from "../src/agent-runtime.js";

test("artifact Agent leaves source identity and approval authority to the Harness", () => {
  assert.match(AGENT_INSTRUCTIONS, /source_ids.*id 字段.*source URL/);
  assert.match(
    AGENT_INSTRUCTIONS,
    /自动 review.*review_pending.*不表示用户已批准/,
  );
  assert.match(AGENT_INSTRUCTIONS, /用户明确要求导出.*必须直接调用 Tool/);
  assert.match(AGENT_INSTRUCTIONS, /Harness 会从 SQLite 重新验证/);
  assert.match(AGENT_INSTRUCTIONS, /草稿任务必须停在 review_pending/);
});
