import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, "apps/web/.next/standalone");
const staticAssets = path.join(root, "apps/web/.next/static");
const publicAssets = path.join(root, "apps/web/public");
const output = path.join(root, "release/chatty");

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function containsFile(dir: string, name: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) return true;
    if (
      entry.isDirectory() &&
      (await containsFile(path.join(dir, entry.name), name))
    ) {
      return true;
    }
  }
  return false;
}

if (!(await exists(path.join(standalone, "apps/web/server.js")))) {
  throw new Error(
    "standalone Next.js server is missing; run the web build first",
  );
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(standalone, output, { recursive: true });
await mkdir(path.join(output, "apps/web/.next"), { recursive: true });
await cp(staticAssets, path.join(output, "apps/web/.next/static"), {
  recursive: true,
});
if (await exists(publicAssets)) {
  await cp(publicAssets, path.join(output, "apps/web/public"), {
    recursive: true,
  });
}

for (const required of ["apps/web/server.js"]) {
  if (!(await exists(path.join(output, required)))) {
    throw new Error(`release artifact is incomplete: ${required}`);
  }
}
if (!(await containsFile(output, "better_sqlite3.node"))) {
  throw new Error("release artifact is missing the SQLite native addon");
}

console.log(`release artifact ready: ${path.relative(root, output)}`);
