import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildAgentTools } from "../src/agent-runtime.js";
import { readEvalCases } from "../src/eval.js";
import { runEval } from "../src/eval-runner.js";

const customerToolNames = [
  "search_knowledge",
  "search_customer_memory",
  "save_customer_memory",
  "check_availability",
  "create_order",
  "view_order",
  "confirm_order",
  "cancel_order",
  "create_handoff",
] as const;

const customerEvalIds = [
  "ordinary-response",
  "knowledge-with-source",
  "order-side-effect",
  "failed-order-completion-verification",
  "explicit-memory-provenance",
  "handoff-receipt",
] as const;

test("resume contract keeps the nine customer Tools on the Agent Runner path", () => {
  const registeredNames = new Set(buildAgentTools().map((tool) => tool.name));

  assert.deepEqual(
    customerToolNames.filter((name) => registeredNames.has(name)),
    customerToolNames,
  );
});

test("resume contract keeps the six customer eval behaviors executable", async () => {
  const sourcePath = resolve(import.meta.dirname, "../../../eval/cases.jsonl");
  const sourceLines = readFileSync(sourcePath, "utf8").trim().split("\n");
  const customerLines = sourceLines.slice(0, customerEvalIds.length);
  const directory = mkdtempSync(join(tmpdir(), "chatty-resume-contract-"));
  const casesPath = join(directory, "cases.jsonl");
  const outputPath = join(directory, "results.jsonl");

  writeFileSync(casesPath, `${customerLines.join("\n")}\n`, "utf8");

  try {
    const cases = readEvalCases(casesPath);
    assert.deepEqual(
      cases.map((evalCase) => evalCase.id),
      customerEvalIds,
    );

    assert.equal(cases[0]?.runs[0]?.expect.status, "responded");
    assert.deepEqual(cases[1]?.runs[0]?.expect.knowledge_sources, [
      "seller-policy://rental-period",
    ]);
    assert.equal(cases[2]?.runs[0]?.expect.business_outcome, "verified");
    assert.equal(cases[3]?.runs[0]?.expect.business_outcome, "not_completed");
    assert.deepEqual(
      cases[4]?.runs.map((run) => run.expect.memory_event_tool),
      ["save_customer_memory", "search_customer_memory"],
    );
    assert.equal(cases[5]?.runs[0]?.expect.support_receipt, true);

    assert.deepEqual(
      await runEval({
        casesPath,
        outputPath,
        workdir: join(directory, "state"),
        knowledgePath: resolve(
          import.meta.dirname,
          "../../../knowledge/records.jsonl",
        ),
      }),
      { passed: 6, failed: 0, total: 6 },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
