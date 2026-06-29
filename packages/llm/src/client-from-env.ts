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
 * stacks. MiMo settings are preferred, with OPENAI_* kept as a compatibility
 * fallback for OpenAI-compatible endpoints.
 *
 * Default model is unified with .env.example so all direct model lanes use MiMo.
 */
export function readLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  return {
    apiKey: env.MIMO_API_KEY ?? env.OPENAI_API_KEY ?? '',
    baseURL: env.MIMO_BASE_URL || env.OPENAI_BASE_URL || undefined,
    chatModel: env.MIMO_MODEL ?? 'mimo-2.5',
  }
}

/**
 * Reads the OpenAI Agents SDK lane config. Falls back to the shared LLM env
 * (MIMO_API_KEY / MIMO_BASE_URL / MIMO_MODEL) so a single provider still
 * works in dev; set OPENAI_AGENTS_* to route the SDK lane to a different
 * endpoint.
 */
export function readAgentsSdkEnv(env: NodeJS.ProcessEnv = process.env): AgentsSdkEnvConfig {
  const shared = readLlmEnv(env)
  return {
    apiKey: env.OPENAI_AGENTS_API_KEY || shared.apiKey,
    baseURL: env.OPENAI_AGENTS_BASE_URL || shared.baseURL,
    model: env.AGENTS_SDK_MODEL || shared.chatModel,
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
