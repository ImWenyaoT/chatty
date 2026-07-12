import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvalHistory } from "./evaluator.js";

// --- normalizeEvalHistory: defensive coercion of arbitrary recentMessages ---
// recentMessages comes from SQLite JSON columns as JsonValue[]; this normalizer
// keeps only well-formed message objects so the evaluator never receives garbage.

test("normalizeEvalHistory keeps well-formed messages and strips extra fields", () => {
  // Imported message shapes may carry extra fields alongside role/content.
  const out = normalizeEvalHistory([
    { role: "user", content: "多少钱", timestamp: "2026-01-01" },
    { role: "assistant", content: "199/天" },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "多少钱" },
    { role: "assistant", content: "199/天" },
  ]);
});

test("normalizeEvalHistory drops entries lacking string role/content", () => {
  const out = normalizeEvalHistory([
    { role: "user", content: "有效" },
    { question: "多少钱", answer: "199" }, // imported shape, no role/content
    { role: "user", content: 123 }, // non-string content
    null,
    "plain string",
  ]);
  assert.deepEqual(out, [{ role: "user", content: "有效" }]);
});

test("normalizeEvalHistory returns [] for non-array input", () => {
  assert.deepEqual(normalizeEvalHistory(undefined), []);
  assert.deepEqual(normalizeEvalHistory({ not: "an array" }), []);
});
