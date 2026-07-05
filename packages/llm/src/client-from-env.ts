import OpenAI from 'openai'

export interface LlmEnvConfig {
  apiKey: string
  baseURL: string | undefined
  chatModel: string
}

/**
 * Reads the shared OpenAI-compatible model config from the environment.
 *
 * These are the shared OpenAI-compatible env var names, so a single local
 * `.env` drives both the app and the eval harness. Any OpenAI-compatible
 * endpoint (DeepSeek, OpenAI, Azure-compatible, moon-bridge, etc.) is selected
 * purely via OPENAI_BASE_URL.
 *
 * Default model is unified with .env.example (deepseek-v4-pro). We pin the
 * explicit `-pro` tier rather than the `deepseek-chat` alias: the alias
 * currently resolves to `deepseek-v4-flash`, whose weaker multi-turn tool-call
 * behavior drops structured output after a tool result — pro holds format.
 */
export function readLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  return {
    apiKey: env.OPENAI_API_KEY ?? '',
    baseURL: env.OPENAI_BASE_URL || undefined,
    chatModel: normalizeChatModel(env.CHAT_MODEL),
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

/** Keeps Chatty on DeepSeek v4 pro even when an alias or old env points at flash. */
function normalizeChatModel(model: string | undefined): string {
  if (!model) return 'deepseek-v4-pro'
  if (/^deepseek-v4-flash$/i.test(model)) return 'deepseek-v4-pro'
  return model
}
