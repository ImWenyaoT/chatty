import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Agent 层需要的凭据形状。
 *
 * 这里刻意不 import 应用层的 `lib/settings.ts`：那份 `Settings` 还带着与 Agent 无关的字段，
 * 而 `agent/` 不该依赖应用层。调用方传进来的对象只要结构上满足这三个字段即可。
 */
export type ModelCredentials = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
};

export class MissingCredentialsError extends Error {}

/** Agent 层只需要“用哪个 Model”和“凭据是否齐全”，因此依赖这个接口而非具体实现。 */
export type ModelProvider = {
  readonly languageModel: LanguageModel;
  readonly configured: boolean;
  readonly modelId: string;
};

/** Request Parser 和主 Agent Loop 共用同一个 OpenAI 兼容 Chat Completions 客户端。 */
export class AiSdkModelProvider implements ModelProvider {
  readonly modelId: string;
  readonly configured: boolean;
  readonly languageModel: LanguageModel;

  constructor(credentials: ModelCredentials) {
    this.modelId = credentials.model;
    this.configured = isUsableApiKey(credentials.apiKey);
    const openai = createOpenAI({
      apiKey: this.configured ? credentials.apiKey : "not-configured",
      baseURL: credentials.baseUrl,
    });
    this.languageModel = openai.chat(credentials.model);
  }
}

/** 把 .env.example 里的占位符当成未配置，避免假 key 打到外网变成 500。 */
function isUsableApiKey(apiKey: string): boolean {
  const key = apiKey.trim();
  if (!key) return false;
  const lower = key.toLowerCase();
  if (lower.includes("your_") || lower.includes("changeme") || lower === "not-configured") {
    return false;
  }
  return true;
}

/** 兼容既有 `api.ts` / eval 的导入名。 */
export { AiSdkModelProvider as ResponsesModelProvider };
