import {
  createResponsesAdapter,
  type ResponseMessage,
  type ResponsesAdapter,
  type ResponsesAdapterOptions,
} from './responses-adapter.js'

export type ChatCompletionsAdapterOptions = ResponsesAdapterOptions
export type ChatCompletionMessage = ResponseMessage
export type ChatCompletionsAdapter = ResponsesAdapter

/**
 * Preserves the old adapter name while routing calls through the Responses API.
 */
export function createChatCompletionsAdapter(options: ChatCompletionsAdapterOptions): ChatCompletionsAdapter {
  return createResponsesAdapter(options)
}
