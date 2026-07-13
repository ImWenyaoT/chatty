import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { resolveChattyDatabasePath } from "./database-path.mjs";

test("web database defaults to a durable data file and honors explicit overrides", () => {
  assert.equal(
    resolveChattyDatabasePath("", "/workspace/chatty"),
    resolve("/workspace/chatty/data/chatty.sqlite"),
  );
  assert.equal(
    resolveChattyDatabasePath("./runtime/custom.sqlite", "/workspace/chatty"),
    resolve("/workspace/chatty/runtime/custom.sqlite"),
  );
  assert.equal(
    resolveChattyDatabasePath(":memory:", "/workspace/chatty"),
    ":memory:",
  );
});
