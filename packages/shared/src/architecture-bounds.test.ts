import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const currentDocRoot = resolve(repoRoot, "docs");
const retiredReferencePattern =
  /\b(Hermes|Pi Agent|pi agent|opencode|OpenCode)\b/;
const directChatCompletionsPattern =
  /\b(?:chat\.completions\.create|createChatCompletionsAdapterFromEnv\(|createChatCompletionsAdapter\()\b/;
const disallowedRetrievalPattern = new RegExp(
  `\\b(?:${[
    ["lang", "chain"].join(""),
    ["llama", "index"].join(""),
    ["vector", "[_ -]?", "database"].join(""),
    ["embedding", "[_ -]?", "rag"].join(""),
  ].join("|")})\\b`,
  "i",
);

function listFiles(
  dir: string,
  extensions: RegExp,
  ignored = new Set([".git", ".next", "dist", "node_modules"]),
): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      if (ignored.has(entry)) return [];
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory())
        return listFiles(absolute, extensions, ignored);
      return extensions.test(absolute) ? [absolute] : [];
    })
    .sort();
}

test("live runtime keeps direct Chat Completions orchestration behind the Agents SDK", () => {
  const offenders = ["apps", "packages/agent-core/src"]
    .flatMap((root) => listFiles(resolve(repoRoot, root), /\.(ts|tsx|mts)$/))
    .filter((file) =>
      directChatCompletionsPattern.test(readFileSync(file, "utf8")),
    )
    .map((file) => relative(repoRoot, file));

  assert.deepEqual(offenders, []);
});

test("runtime manifests and source stay free of RAG and vector database dependencies", () => {
  const offenders = listFiles(repoRoot, /(?:package\.json|\.(ts|tsx|mts))$/)
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) =>
      disallowedRetrievalPattern.test(readFileSync(file, "utf8")),
    )
    .map((file) => relative(repoRoot, file));

  assert.deepEqual(offenders, []);
});

test("current architecture docs use Claude Code as the sole named agent reference", () => {
  const docs = listFiles(currentDocRoot, /\.md$/).filter(
    (file) =>
      !relative(currentDocRoot, file).startsWith("archive/") &&
      file !== resolve(currentDocRoot, "jd.md"),
  );
  const retired = docs
    .filter((file) => retiredReferencePattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(repoRoot, file));
  const adr = readFileSync(
    resolve(repoRoot, "docs/adr/0001-architecture-reference-claude-code.md"),
    "utf8",
  );

  assert.deepEqual(retired, []);
  assert.match(adr, /claude-code/i);
  assert.match(adr, /删除/);
});

test("Search Execution, memory, and indexed knowledge remain concrete modules", () => {
  for (const path of [
    "packages/agent-core/src/search-execution.ts",
    "packages/db/src/knowledge-index.ts",
    "packages/db/src/memory-repository.ts",
  ]) {
    assert.ok(
      statSync(resolve(repoRoot, path)).isFile(),
      `${path} should exist`,
    );
  }
});
