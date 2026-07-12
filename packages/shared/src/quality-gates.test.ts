import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATED_BEHAVIOR_COVERAGE_RULE,
  DEVELOPMENT_METHOD_RULE,
  REFERENCE_DEBUGGING_METHOD,
  REQUIRED_LOCAL_QUALITY_COMMANDS,
  REQUIRED_PULL_REQUEST_CHECKS,
  getRequiredQualityCommandNames,
  getRequiredPullRequestCheckNames,
} from "./quality-gates.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const rootPackageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
};

const ciWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const evalWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/eval.yml"),
  "utf8",
);
const agentInstructions = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
const designDoc = readFileSync(resolve(repoRoot, "docs/design.md"), "utf8");
const developmentMethodDoc = readFileSync(
  resolve(repoRoot, "docs/development-method.md"),
  "utf8",
);

/** 列出当前源码和当前文档文件；archive 是历史证据，不参与当前 runtime 契约。 */
function listCurrentProjectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = join(dir, entry);
    const rel = relative(repoRoot, absolute);
    if (
      rel === "node_modules" ||
      rel === ".git" ||
      rel === ".next" ||
      rel === "dist" ||
      rel === "docs/archive" ||
      rel.startsWith(`docs/archive/`) ||
      rel.startsWith(`apps/web/.next/`) ||
      rel.includes("/dist/")
    ) {
      return [];
    }
    if (statSync(absolute).isDirectory())
      return listCurrentProjectFiles(absolute);
    return /\.(ts|tsx|mts|md|json|yml|yaml)$/.test(absolute) ? [absolute] : [];
  });
}

test("quality policy states that every automatically verifiable behavior needs automated verification", () => {
  assert.match(AUTOMATED_BEHAVIOR_COVERAGE_RULE, /所有能被自动验证的行为/);
  assert.match(AUTOMATED_BEHAVIOR_COVERAGE_RULE, /自动验证/);
});

test("required local quality commands are present in package scripts", () => {
  for (const command of REQUIRED_LOCAL_QUALITY_COMMANDS) {
    assert.ok(
      rootPackageJson.scripts[command.scriptName],
      `${command.scriptName} should be a root script`,
    );
    assert.equal(rootPackageJson.scripts[command.scriptName], command.command);
  }

  assert.deepEqual(getRequiredQualityCommandNames(), [
    "build:skeleton",
    "lint",
    "smoke",
    "test",
    "test:frontend",
    "test:coverage",
    "typecheck",
    "build",
  ]);
});

test("pull request quality checks are wired into CI in the same order as the policy", () => {
  const checkNames = getRequiredPullRequestCheckNames();
  assert.deepEqual(checkNames, [
    "Build package skeleton",
    "Lint and format",
    "Smoke test (core data path, no network)",
    "Test workspaces",
    "Control-plane integration",
    "Web core coverage",
    "Frontend experience contract",
    "Typecheck workspaces",
    "Build workspaces",
  ]);

  const positions = checkNames.map((name) =>
    ciWorkflow.indexOf(`name: ${name}`),
  );
  assert.ok(
    positions.every((position) => position >= 0),
    "every required CI check should exist",
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );

  for (const check of REQUIRED_PULL_REQUEST_CHECKS) {
    assert.ok(
      ciWorkflow.includes(`run: ${check.command}`),
      `${check.command} should be run in CI`,
    );
  }

  assert.doesNotMatch(
    REQUIRED_PULL_REQUEST_CHECKS.map((check) => check.purpose).join("\n"),
    /Vercel-first/,
  );
});

test("CI runs durable control-plane integration and enforces web-core coverage", () => {
  assert.equal(
    rootPackageJson.scripts["test:coverage"],
    "pnpm --filter @chatty/web test:coverage",
  );
  assert.match(
    ciWorkflow,
    /name: Control-plane integration[\s\S]*run: pnpm test:control-plane-integration/,
  );
  assert.match(
    ciWorkflow,
    /name: Web core coverage[\s\S]*run: pnpm test:coverage/,
  );
  const webPackageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/web/package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(
    webPackageJson.scripts["test:coverage"],
    /--test-coverage-lines=87/,
  );
  assert.match(
    webPackageJson.scripts["test:coverage"],
    /--test-coverage-branches=75/,
  );
  assert.match(
    webPackageJson.scripts["test:coverage"],
    /--test-coverage-functions=81/,
  );
});

test("manual LLM golden eval remains documented as the integration gate for model behavior", () => {
  assert.match(evalWorkflow, /workflow_dispatch/);
  assert.match(evalWorkflow, /pnpm eval -- --repeat 3 --save ci-latest/);
  assert.match(evalWorkflow, /OPENAI_API_KEY/);
});

test("agent instructions retain the current issue-tracker and pull-request contract", () => {
  assert.match(agentInstructions, /GitHub Issues/);
  for (const label of [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
  ]) {
    assert.match(agentInstructions, new RegExp(`\\b${label}\\b`));
  }
  assert.match(agentInstructions, /single-context repo/);
  assert.match(agentInstructions, /\[chatty\] <Title>/);
  assert.match(agentInstructions, /pnpm lint/);
  assert.match(agentInstructions, /pnpm test/);
});

test("design contract protects the private JD input and repository boundary", () => {
  assert.match(designDoc, /docs\/jd\.md.*私有输入/);
  assert.match(designDoc, /\.gitignore.*不随开源仓分发/);
  assert.match(designDoc, /不把实现决策反写回去/);
});

test("development method keeps implementation inside the reference bounds", () => {
  assert.match(DEVELOPMENT_METHOD_RULE, /jd\.md/);
  assert.match(DEVELOPMENT_METHOD_RULE, /openclaw/);
  assert.match(DEVELOPMENT_METHOD_RULE, /codex/);
  assert.match(DEVELOPMENT_METHOD_RULE, /claude-code/);

  assert.deepEqual(REFERENCE_DEBUGGING_METHOD.allowedReferences, [
    "openclaw",
    "codex",
    "claude-code",
  ]);
  assert.equal(REFERENCE_DEBUGGING_METHOD.requiresSingleReferenceChoice, true);
  assert.equal(REFERENCE_DEBUGGING_METHOD.requiresSmallestReproduction, true);
});

test("reference debugging method is documented for future agent work", () => {
  assert.match(developmentMethodDoc, /参考实现三选一/);
  assert.match(developmentMethodDoc, /搭积木复现法/);
  assert.match(developmentMethodDoc, /自动化回归/);
});

test("deprecated LLM runtime switches stay out of current code and docs", () => {
  const deprecatedSwitches = [
    ["CHATTY", "LLM"],
    ["CHAT", "LLM"],
    ["CHATTY", "AGENTS", "SDK"],
    ["CHAT", "AGENTS", "SDK"],
    ["chat", "llm"],
    ["chatty", "llm"],
  ].map((parts) => parts.join("_"));
  const deprecatedSwitchPattern = new RegExp(
    `\\b(${deprecatedSwitches.join("|")})\\b`,
  );
  const offenders = listCurrentProjectFiles(repoRoot).flatMap((file) => {
    const content = readFileSync(file, "utf8");
    return deprecatedSwitchPattern.test(content)
      ? [relative(repoRoot, file)]
      : [];
  });

  assert.deepEqual(offenders, []);
});
