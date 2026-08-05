/**
 * Chatty 运行配置。
 *
 * 本地文件是显式配置，因此优先级为 .env.local > .env > 系统环境变量。
 */

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { z } from "zod";

export const ROOT = new URL("../../", import.meta.url);
export const FRONTEND_DIST = new URL("frontend/dist/", ROOT);

const settingsSchema = z.object({
  apiKey: z.string().default(""),
  baseUrl: z.string().default("https://api.deepseek.com"),
  model: z.string().default("deepseek-v4-flash"),
  port: z.coerce.number().int().default(8000),
});
export type Settings = z.infer<typeof settingsSchema>;

function readEnvFile(path: URL): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    // 缺少 .env 是正常状态；语法或权限错误必须抛出，否则配置会被静默忽略。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** 一个配置项可以由多个环境变量名提供，取第一个非空值。 */
function pick(values: Record<string, string | undefined>, ...names: string[]) {
  for (const name of names) {
    const value = values[name];
    if (value) return value;
  }
  return undefined;
}

export function loadSettings(root: URL = ROOT): Settings {
  // 后读取的文件覆盖前面的值，所以最终优先级是
  // .env.local > .env > 系统环境变量。
  const values: Record<string, string | undefined> = {
    ...process.env,
    ...readEnvFile(new URL(".env", root)),
    ...readEnvFile(new URL(".env.local", root)),
  };
  return settingsSchema.parse({
    apiKey: pick(values, "DEEPSEEK_API_KEY", "OPENAI_API_KEY"),
    baseUrl: pick(values, "DEEPSEEK_BASE_URL", "OPENAI_BASE_URL"),
    model: pick(values, "DEEPSEEK_MODEL", "MODEL_ID"),
    port: pick(values, "PORT"),
  });
}
