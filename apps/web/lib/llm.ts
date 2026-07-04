import {
  CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
  type CustomerServiceModelFn,
} from '@rental/agent-core'
import { createChatCompletionsAdapterFromEnv, readLlmEnv } from '@rental/llm'

/**
 * Builds the optional LLM compose call for the playground harness step.
 *
 * Double gate: CHATTY_LLM=1 must be set explicitly AND OPENAI_API_KEY must be
 * present (client-from-env convention, any OpenAI-compatible endpoint via
 * OPENAI_BASE_URL). Returns undefined otherwise, which keeps the playground on
 * the deterministic composer with zero configuration.
 */
export function createPlaygroundModelFn(): CustomerServiceModelFn | undefined {
  if (process.env.CHATTY_LLM !== '1') return undefined
  if (!readLlmEnv().apiKey) return undefined
  const adapter = createChatCompletionsAdapterFromEnv()
  return (prompt) =>
    adapter.complete([
      { role: 'system', content: CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS },
      { role: 'user', content: prompt },
    ])
}
