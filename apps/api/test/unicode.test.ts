import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { unicodeCaseFold } from "../src/unicode.js";

test("Unicode folding stays pinned to Python 3.12 and UCD 15.0", () => {
  const digest = createHash("sha256");
  let mappings = 0;
  for (let codePoint = 0; codePoint < 0x11_0000; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    const folded = unicodeCaseFold(character);
    if (folded === character) continue;
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(codePoint);
    digest.update(bytes).update("\0").update(folded).update("\0");
    mappings += 1;
  }
  assert.equal(mappings, 1530);
  assert.equal(
    digest.digest("hex"),
    "f76411c6e67300172925a3dcd4bf5146ae9f8fdabd9752fe5b73f6a87fbaa793",
  );
  assert.equal(unicodeCaseFold("Weiß Σςσ"), "weiss σσσ");
});
