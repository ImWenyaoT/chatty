import path from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";

const cwd = process.cwd();
export const ROOT = existsSync(path.join(cwd, "data"))
  ? cwd
  : path.resolve(cwd, "../..");
export const DATA_DIR = path.join(ROOT, "data");
export const DATABASE_PATH = path.join(ROOT, ".local", "chatty.db");
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";

let loaded = false;
export function loadRootEnv(): void {
  if (loaded) return;
  // dotenv 默认不覆盖已有 process.env；文件优先级从具体到通用。
  loadEnv({
    path: [path.join(ROOT, ".env.local"), path.join(ROOT, ".env")],
    override: false,
    quiet: true,
  });
  loaded = true;
}

export function modelConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env === process.env) loadRootEnv();
  return {
    apiKey: env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || "",
    baseURL: env.DEEPSEEK_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    model: env.DEEPSEEK_MODEL || env.MODEL_ID || DEFAULT_MODEL_ID,
  };
}
