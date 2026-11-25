/**
 * 把 Vite 构建产物同步到仓库根 `dist/`，供 Hono 生产静态托管。
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = `${root}/web/dist`;
const target = `${root}/dist`;

if (!existsSync(source)) {
  console.error("web_dist_missing:", source);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log("copied web/dist -> dist/");
