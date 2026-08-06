/**
 * 发现并运行 `evals/` 下的 Eval。
 *
 * `evals/<name>.eval.ts` 就是名为 `<name>` 的 Eval，身份来自路径，文件里不写 id 或 name。
 * 命令行参数按前缀筛选：`node evals/lib/runner.ts retrieval` 只跑 `retrieval.eval.ts`。
 *
 * 退出码 0 表示每个跑过的 Eval 都过了自己的 gate——与 `eve eval` 的语义一致。
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadSettings } from "../../lib/settings.ts";
import config from "../evals.config.ts";
import type { EvalDefinition } from "./define-eval.ts";

const EVALS_DIR = new URL("../", import.meta.url);
const SUFFIX = ".eval.ts";

/** 后缀判别，因此 `lib/` 与 `evals.config.ts` 不会被当成 Eval。 */
export function discoverEvalNames(): string[] {
  return readdirSync(fileURLToPath(EVALS_DIR))
    .filter((file) => file.endsWith(SUFFIX))
    .map((file) => file.slice(0, -SUFFIX.length))
    .sort();
}

async function main(filters: readonly string[]): Promise<void> {
  const names = discoverEvalNames().filter(
    (name) => filters.length === 0 || filters.includes(name),
  );
  if (names.length === 0) {
    console.error(`no_eval_matched: ${filters.join(", ") || "(all)"}`);
    process.exitCode = 1;
    return;
  }

  const hasCredentials = Boolean(loadSettings().apiKey);
  let failed = 0;

  for (const name of names) {
    const module = await import(new URL(`${name}${SUFFIX}`, EVALS_DIR).href);
    const definition = module.default as EvalDefinition | undefined;
    if (definition === undefined) {
      throw new Error(`eval_missing_default_export:${name}`);
    }

    if (definition.requiresModel && !hasCredentials) {
      // 缺凭据不是 Eval 失败，是环境没准备好——由 config 决定怎么处理。
      console.log(
        JSON.stringify({ eval: name, skipped: "missing_credentials" }),
      );
      if (config.onMissingCredentials === "fail") failed += 1;
      continue;
    }

    const result = await definition.run();
    const gate = definition.gate ?? config.defaultGate;
    const passed = gate(result);
    console.log(
      JSON.stringify({
        eval: name,
        passed,
        cases: `${result.passed}/${result.total}`,
      }),
    );
    if (!passed) failed += 1;
  }

  if (failed > 0) process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
