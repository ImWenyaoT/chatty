import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GOLDEN_DIR = new URL("../fixtures/golden/", import.meta.url);

export type GoldenCase = {
  name: string;
  op: string;
  input: Record<string, unknown>;
};

export type GoldenOutcome = { ok: unknown } | { error: string };

function read(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(name, GOLDEN_DIR)), "utf8"),
  );
}

export function loadCases(): GoldenCase[] {
  return (read("data-layer.cases.json") as { cases: GoldenCase[] }).cases;
}

export function loadExpected(): Record<string, GoldenOutcome> {
  return read("data-layer.expected.json") as Record<string, GoldenOutcome>;
}

export function caseKey(testCase: GoldenCase): string {
  return `${testCase.op}::${testCase.name}`;
}
