import assert from "node:assert/strict";
import test from "node:test";
import { cn } from "../src/lib/utils";

test("cn keeps conditional classes and resolves Tailwind conflicts", () => {
  assert.equal(cn("px-2", false, "text-sm", "px-4"), "text-sm px-4");
});
