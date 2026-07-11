import OpenAI from 'openai'

export interface LlmEnvConfig {
  apiKey: string
  baseURL: string | undefined
  chatModel: string
}

/**
 * Reads the shared DeepSeek model config from the environment.
 *
 * `OPENAI_*` remains the env naming convention because the official OpenAI
 * npm client is used as an OpenAI-format HTTP client for DeepSeek. The target
 * model is still DeepSeek, and callers should not infer OpenAI model support
 * from the variable names.
 *
 * Default model is unified with .env.example (deepseek-v4-pro). We pin the
 * explicit `-pro` tier rather than DeepSeek's flash/deprecated aliases.
 */
export function readLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  return {
    apiKey: env.OPENAI_API_KEY ?? '',
    baseURL: env.OPENAI_BASE_URL || 'https://api.deepseek.com/beta',
    chatModel: normalizeChatModel(env.CHAT_MODEL),
  }
}

/**
 * Builds the shared OpenAI-format client for DeepSeek. Re-exported so callers
 * do not depend on the `openai` package directly.
 */
export function createOpenAiClientFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAI {
  const { apiKey, baseURL } = readLlmEnv(env)
  return new OpenAI({ apiKey, baseURL })
}

/** Keeps Chatty on DeepSeek v4 pro even when an alias or old env points at flash. */
function normalizeChatModel(model: string | undefined): string {
  if (!model) return 'deepseek-v4-pro'
  if (/^(deepseek-v4-flash|deepseek-chat|deepseek-reasoner)$/i.test(model)) {
    return 'deepseek-v4-pro'
  }
  return model
}
