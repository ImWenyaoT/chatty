import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlaygroundAuthorized } from "./auth.js";

test("isPlaygroundAuthorized is open when no key is configured (zero-config dev)", () => {
  assert.equal(isPlaygroundAuthorized(undefined, undefined), true);
  assert.equal(isPlaygroundAuthorized(null, undefined), true);
  assert.equal(isPlaygroundAuthorized("whatever", ""), true);
});

test("isPlaygroundAuthorized requires a matching key when one is configured", () => {
  assert.equal(isPlaygroundAuthorized("secret", "secret"), true);
  assert.equal(isPlaygroundAuthorized("wrong", "secret"), false);
  assert.equal(isPlaygroundAuthorized("", "secret"), false);
  assert.equal(isPlaygroundAuthorized(null, "secret"), false);
  assert.equal(isPlaygroundAuthorized(undefined, "secret"), false);
});

test("isPlaygroundAuthorized rejects a wrong key even of the same length", () => {
  // length-equal but different content must still fail (timing-safe path)
  assert.equal(isPlaygroundAuthorized("abcdef", "secret"), false);
});
