import {
  createResponsesAdapter,
  type ResponseMessage,
  type ResponsesAdapter,
  type ResponsesAdapterOptions,
} from './responses-adapter.js'
import { createOpenAiClientFromEnv, readLlmEnv } from './client-from-env.js'

export type ChatCompletionsAdapterOptions = ResponsesAdapterOptions
export type ChatCompletionMessage = ResponseMessage
export type ChatCompletionsAdapter = ResponsesAdapter

/**
 * Preserves the old adapter name while routing calls through the Responses API.
 */
export function createChatCompletionsAdapter(options: ChatCompletionsAdapterOptions): ChatCompletionsAdapter {
  return createResponsesAdapter(options)
}

/**
 * Creates the legacy-named adapter from environment while routing through Responses.
 */
export function createChatCompletionsAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): ChatCompletionsAdapter {
  const llmEnv = readLlmEnv(env)
  return createResponsesAdapter({
    client: createOpenAiClientFromEnv(env),
    model: llmEnv.chatModel,
  })
}
