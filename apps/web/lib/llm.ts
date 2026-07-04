import {
  CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
  type CustomerServiceModelFn,
} from '@rental/agent-core'
import {
  type ChatCompletionsAdapter,
  createChatCompletionsAdapterFromEnv,
  readLlmEnv,
} from '@rental/llm'

/**
 * Wraps a Chat Completions adapter into the harness compose modelFn.
 *
 * Goes through completeJson (response_format json_object hint + tolerant
 * extraction of JSON wrapped in ```json fences or surrounding prose — common
 * with OpenAI-compatible endpoints like DeepSeek) instead of raw complete(),
 * then re-stringifies the parsed object so parseCustomerServiceOutput always
 * receives bare JSON. When the reply contains no parseable JSON at all,
 * completeJson throws and composeCustomerServiceModelOutput falls back to the
 * deterministic composer — never the parser's generic fallbackAction wording.
 */
export function createComposeModelFn(adapter: ChatCompletionsAdapter): CustomerServiceModelFn {
  return async (prompt) => {
    const parsed = await adapter.completeJson<Record<string, unknown>>([
      { role: 'system', content: CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS },
      { role: 'user', content: prompt },
    ])
    return JSON.stringify(parsed)
  }
}

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
  return createComposeModelFn(createChatCompletionsAdapterFromEnv())
}
