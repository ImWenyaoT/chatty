import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runEval } from "../src/eval-runner.js";

test("TypeScript deterministic eval exercises the official Runner path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-typescript-eval-"));
  const casesPath = resolve(import.meta.dirname, "../../../eval/cases.jsonl");
  const outputPath = join(directory, "results.jsonl");
  try {
    assert.deepEqual(
      await runEval({
        casesPath,
        outputPath,
        workdir: join(directory, "state"),
      }),
      { passed: 7, failed: 0, total: 7 },
    );
    const results = readFileSync(outputPath, "utf8").trim().split("\n");
    assert.equal(results.length, 7);
    assert(results.every((line) => JSON.parse(line).passed === true));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
