import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test("repository keeps one TypeScript Agent runtime and a thin web client", () => {
  const forbidden = [
    "src/chatty",
    "main.py",
    "pyproject.toml",
    "uv.lock",
    "apps/web/app/api",
    "apps/web/lib/db.ts",
    "apps/web/lib/background-job-worker.ts",
  ];
  assert.deepEqual(
    forbidden.filter((path) => existsSync(join(root, path))),
    [],
  );

  const apiSources = files(join(root, "apps/api/src")).filter((path) =>
    path.endsWith(".ts"),
  );
  const webSources = files(join(root, "apps/web/src")).filter((path) =>
    /\.tsx?$/.test(path),
  );
  const api = apiSources.map((path) => readFileSync(path, "utf8")).join("\n");
  const web = webSources.map((path) => readFileSync(path, "utf8")).join("\n");

  assert.equal((api.match(/from "@openai\/agents"/g) ?? []).length > 0, true);
  assert.equal(web.includes("@openai/agents"), false);
  assert.equal(/better-sqlite3|node:sqlite/i.test(web), false);
  assert.equal(
    /\b(?:outbox|worker|checkpoint|vector database)\b/i.test(api + web),
    false,
  );
  assert.equal(api.includes("CHATTY_PYTHON"), false);
  assert.equal(/\bFastify\b|from "fastify"|@fastify\//.test(api), false);
});

test("documentation and CI expose the executable TypeScript gates", () => {
  for (const file of ["README.md", "README.en.md"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.match(text.toLowerCase(), /agent = model \+ harness/);
    for (const command of [
      "pnpm lint",
      "pnpm test",
      "pnpm typecheck",
      "pnpm build",
      "pnpm eval",
      "pnpm test:e2e",
    ]) {
      assert.equal(text.includes(command), true, `${file}: ${command}`);
    }
    assert.equal(/uv run|FastAPI|CHATTY_PYTHON/.test(text), false);
  }

  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  for (const command of [
    "pnpm lint",
    "pnpm test",
    "pnpm typecheck",
    "pnpm build",
    "pnpm eval",
    "pnpm test:e2e",
  ]) {
    assert.equal(ci.includes(command), true, `CI: ${command}`);
  }
  assert.match(ci, /start --port 3101/);
  assert.match(ci, /127\.0\.0\.1:3101\/api\/chatty\/health/);
  const playwright = readFileSync(
    join(root, "apps/web/playwright.config.ts"),
    "utf8",
  );
  assert.match(playwright, /127\.0\.0\.1:3100/);
  assert.equal(/setup-uv|pytest|ruff|uv run/.test(ci), false);
  assert.equal(relative(root, join(root, "CONTEXT.md")), "CONTEXT.md");
});
