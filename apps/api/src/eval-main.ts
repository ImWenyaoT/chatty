import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runEval } from "./eval-runner.js";

const { values } = parseArgs({
  options: {
    cases: { type: "string", default: "eval/cases.jsonl" },
    output: { type: "string", default: "eval/results.jsonl" },
    workdir: { type: "string", default: ".cache/eval-typescript" },
  },
});

const summary = await runEval({
  casesPath: resolve(values.cases),
  outputPath: resolve(values.output),
  workdir: resolve(values.workdir),
});
console.log(JSON.stringify(summary));
process.exitCode = summary.failed === 0 ? 0 : 1;
