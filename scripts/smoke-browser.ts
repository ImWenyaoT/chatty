/**
 * 用 agent-browser 对本地演示页做一次可访问性快照冒烟检查。
 *
 * 前置：`pnpm dev` 已在跑（Next :3000）。
 * 这不是 CI 门禁——真实模型与浏览器依赖不适合默认流水线。
 */

import { spawnSync } from "node:child_process";

const baseUrl = process.env.CHATTY_SMOKE_URL ?? "http://127.0.0.1:3000";

function run(args: string[]): string {
  const result = spawnSync("pnpm", ["exec", "agent-browser", ...args], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || "agent-browser_failed";
    throw new Error(detail.trim());
  }
  return result.stdout;
}

try {
  run(["open", baseUrl]);
  const snapshot = run(["snapshot", "-i"]);
  if (!/Chatty|对话|推荐|商品/.test(snapshot)) {
    throw new Error(`unexpected_snapshot:\n${snapshot.slice(0, 500)}`);
  }
  console.log("smoke:browser ok");
  console.log(snapshot.slice(0, 800));
} finally {
  spawnSync("pnpm", ["exec", "agent-browser", "close"], {
    encoding: "utf8",
    env: process.env,
  });
}
