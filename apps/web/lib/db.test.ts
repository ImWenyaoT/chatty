import assert from "node:assert/strict";
import test from "node:test";
import { getRepos, newId } from "./db";

test("web repository factory shares one SQLite-backed repository graph", () => {
  const first = getRepos();
  const second = getRepos();

  assert.equal(first, second);
  assert.equal(first.sessions.get("missing-session"), undefined);
  assert.match(newId("trace"), /^trace_[0-9a-f-]{36}$/);
});
