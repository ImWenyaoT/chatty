import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rootPackageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const ciWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const evalWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/eval.yml"),
  "utf8",
);
const releaseWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/release.yml"),
  "utf8",
);
const agentInstructions = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");

function listCurrentProjectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = join(dir, entry);
    const rel = relative(repoRoot, absolute);
    if (
      ["node_modules", ".git", ".next", "dist"].includes(entry) ||
      rel === "docs/archive" ||
      rel.startsWith("docs/archive/") ||
      rel.startsWith("apps/web/.next/") ||
      rel.includes("/dist/")
    )
      return [];
    if (statSync(absolute).isDirectory())
      return listCurrentProjectFiles(absolute);
    return /\.(ts|tsx|mts|md|json|yml|yaml)$/.test(absolute) ? [absolute] : [];
  });
}

test("root scripts expose every local quality gate used by the project", () => {
  for (const script of [
    "build:skeleton",
    "lint",
    "smoke",
    "test",
    "test:frontend",
    "test:coverage",
    "test:coverage:core",
    "test:fullstack",
    "typecheck",
    "build",
  ])
    assert.ok(
      rootPackageJson.scripts[script],
      `${script} should be a root script`,
    );
});

test("CI runs the full quality story in failure-localizing order", () => {
  const checks = [
    ["Build package skeleton", "pnpm build:skeleton"],
    ["Lint and format", "pnpm lint"],
    ["Smoke test (core data path, no network)", "node scripts/smoke.mts"],
    ["Test workspaces", "pnpm test"],
    ["Full-stack integration", "pnpm test:fullstack"],
    ["Core package coverage", "pnpm test:coverage:core"],
    ["Web core coverage", "pnpm test:coverage"],
    ["Frontend experience contract", "pnpm test:frontend"],
    ["Typecheck workspaces", "pnpm typecheck"],
    ["Build workspaces", "pnpm build"],
  ] as const;
  const positions = checks.map(([name]) => ciWorkflow.indexOf(`name: ${name}`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
  for (const [, command] of checks)
    assert.match(
      ciWorkflow,
      new RegExp(`run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
});

test("coverage and manual golden evaluation stay wired", () => {
  assert.match(
    rootPackageJson.scripts["test:coverage:core"],
    /test-coverage-lines=90/,
  );
  assert.match(
    rootPackageJson.scripts["test:coverage:core"],
    /test-coverage-branches=84/,
  );
  assert.match(evalWorkflow, /workflow_dispatch/);
  assert.match(evalWorkflow, /pnpm eval -- --repeat 3 --save ci-latest/);
  assert.match(evalWorkflow, /OPENAI_API_KEY/);
});

test("tag delivery packages and smoke-checks a standalone SQLite-capable server", () => {
  assert.ok(rootPackageJson.scripts["package:release"]);
  assert.match(releaseWorkflow, /tags:[\s\S]*- "v\*"/);
  assert.match(releaseWorkflow, /run: pnpm package:release/);
  assert.match(releaseWorkflow, /CHATTY_DB_PATH/);
  assert.match(releaseWorkflow, /\/api\/health/);
  assert.match(releaseWorkflow, /gh release create/);
});

test("agent instructions retain repository and pull-request hygiene", () => {
  assert.match(agentInstructions, /GitHub Issues/);
  assert.match(agentInstructions, /\[chatty\] <Title>/);
  assert.match(agentInstructions, /pnpm lint/);
  assert.match(agentInstructions, /pnpm test/);
});

test("deprecated LLM runtime switches stay out of current code and docs", () => {
  const deprecated = [
    ["CHATTY", "LLM"],
    ["CHAT", "LLM"],
    ["CHATTY", "AGENTS", "SDK"],
    ["CHAT", "AGENTS", "SDK"],
    ["chat", "llm"],
    ["chatty", "llm"],
  ].map((parts) => parts.join("_"));
  const pattern = new RegExp(`\\b(${deprecated.join("|")})\\b`);
  const offenders = listCurrentProjectFiles(repoRoot)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(repoRoot, file));
  assert.deepEqual(offenders, []);
});
