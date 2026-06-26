import OpenAI from 'openai'

export interface LlmEnvConfig {
  apiKey: string
  baseURL: string | undefined
  chatModel: string
}

export interface AgentsSdkEnvConfig {
  /** Separate OpenAI-compatible endpoint for the Agents SDK lane (docs §5.2). */
  apiKey: string
  baseURL: string | undefined
  /** Model the Agents SDK Agent resolves against (typically a stronger OpenAI model). */
  model: string
}

/**
 * Reads the shared OpenAI-compatible model config from the environment.
 *
 * Names mirror rag-service/src/config.ts so a single local `.env` drives both
 * stacks. Any OpenAI-compatible endpoint (DeepSeek, OpenAI, Azure-compatible,
 * moon-bridge, etc.) is selected purely via OPENAI_BASE_URL.
 *
 * Default model is unified with .env.example (deepseek-chat) to avoid the
 * divergence that existed between the two before the dual-provider change.
 */
export function readLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  return {
    apiKey: env.OPENAI_API_KEY ?? '',
    baseURL: env.OPENAI_BASE_URL || undefined,
    chatModel: env.CHAT_MODEL ?? 'deepseek-chat',
  }
}

/**
 * Reads the OpenAI Agents SDK lane config. Falls back to the shared LLM env
 * (OPENAI_API_KEY / OPENAI_BASE_URL / CHAT_MODEL) so a single provider still
 * works in dev; set OPENAI_AGENTS_* to route the SDK lane to a different
 * endpoint (e.g. a real OpenAI endpoint when classification runs on DeepSeek).
 */
export function readAgentsSdkEnv(env: NodeJS.ProcessEnv = process.env): AgentsSdkEnvConfig {
  return {
    apiKey: env.OPENAI_AGENTS_API_KEY || env.OPENAI_API_KEY || '',
    baseURL: env.OPENAI_AGENTS_BASE_URL || env.OPENAI_BASE_URL || undefined,
    model: env.AGENTS_SDK_MODEL || env.CHAT_MODEL || 'deepseek-chat',
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

/**
 * Builds an OpenAI client scoped to the Agents SDK lane, for injection into
 * setDefaultOpenAIClient when the SDK lane targets a different endpoint.
 */
export function createAgentsSdkClientFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAI {
  const { apiKey, baseURL } = readAgentsSdkEnv(env)
  return new OpenAI({ apiKey, baseURL })
}
