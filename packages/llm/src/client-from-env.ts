import OpenAI from 'openai'

export interface LlmEnvConfig {
  apiKey: string
  baseURL: string | undefined
  chatModel: string
}

/**
 * Reads the shared OpenAI-compatible model config from the environment.
 *
 * Names mirror rag-service/src/config.ts so a single local `.env` drives both
 * stacks. Any OpenAI-compatible endpoint (DeepSeek, OpenAI, Azure-compatible,
 * moon-bridge, etc.) is selected purely via OPENAI_BASE_URL.
 */
export function readLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  return {
    apiKey: env.OPENAI_API_KEY ?? '',
    baseURL: env.OPENAI_BASE_URL || undefined,
    chatModel: env.CHAT_MODEL ?? 'gpt-5.2',
  }
}

/**
 * Builds the shared OpenAI client from environment. Re-exported so callers do
 * not depend on the `openai` package directly.
 */
export function createOpenAiClientFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAI {
  const { apiKey, baseURL } = readLlmEnv(env)
  return new OpenAI({ apiKey, baseURL })
}
