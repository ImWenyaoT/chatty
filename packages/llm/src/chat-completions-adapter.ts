import OpenAI from 'openai'

export interface ChatCompletionsAdapterOptions {
  client: OpenAI
  model: string
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionsAdapter {
  complete(messages: ChatCompletionMessage[]): Promise<string>
}

/**
 * Creates a direct Chat Completions adapter for extraction, eval, and legacy fallback paths.
 */
export function createChatCompletionsAdapter(options: ChatCompletionsAdapterOptions): ChatCompletionsAdapter {
  return {
    async complete(messages: ChatCompletionMessage[]) {
      const response = await options.client.chat.completions.create({
        model: options.model,
        messages,
      })

      return response.choices[0]?.message?.content?.trim() ?? ''
    },
  }
}
