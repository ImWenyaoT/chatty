import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EvalRequestTimeoutError,
  parseEvalTimeoutMs,
  withEvalDeadline,
} from "./deadline.js";

test("withEvalDeadline aborts and identifies a request that never settles", async () => {
  let observedAbort = false;

  await assert.rejects(
    withEvalDeadline("judge:happy-path:0", 20, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }),
    (error: unknown) => {
      assert.ok(error instanceof EvalRequestTimeoutError);
      assert.equal(error.label, "judge:happy-path:0");
      assert.equal(error.timeoutMs, 20);
      return true;
    },
  );

  assert.equal(observedAbort, true);
});

test("withEvalDeadline rejects even when an operation ignores cancellation", async () => {
  await assert.rejects(
    withEvalDeadline(
      "harness:stalled:0",
      20,
      () => new Promise<never>(() => undefined),
    ),
    /eval request timed out after 20ms: harness:stalled:0/,
  );
});

test("withEvalDeadline rejects invalid timeout configuration immediately", async () => {
  await assert.rejects(
    withEvalDeadline("judge:bad-config", 0, async () => "unused"),
    /eval timeout must be between 1 and 600000ms/,
  );
});

test("withEvalDeadline returns a normally completed operation", async () => {
  const result = await withEvalDeadline("judge:fast", 1_000, async (signal) => {
    assert.equal(signal.aborted, false);
    return { score: 9 };
  });
  assert.deepEqual(result, { score: 9 });
});

test("withEvalDeadline preserves an operation failure before the deadline", async () => {
  await assert.rejects(
    withEvalDeadline("judge:failed", 1_000, async () => {
      throw new Error("provider rejected request");
    }),
    /provider rejected request/,
  );
});

test("parseEvalTimeoutMs defaults, parses, and rejects malformed CLI values", () => {
  assert.equal(parseEvalTimeoutMs(undefined), 60_000);
  assert.equal(parseEvalTimeoutMs("2500"), 2_500);
  assert.throws(() => parseEvalTimeoutMs("nope"), /between 1 and 600000ms/);
  assert.throws(() => parseEvalTimeoutMs(true), /between 1 and 600000ms/);
  assert.throws(() => parseEvalTimeoutMs("0"), /between 1 and 600000ms/);
  assert.throws(() => parseEvalTimeoutMs("600001"), /between 1 and 600000ms/);
});
