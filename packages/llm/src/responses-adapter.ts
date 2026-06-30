export interface ResponsesAdapterOptions {
  client: {
    responses: {
      create(payload: { model: string; input: ResponseMessage[] }): Promise<{ output_text: string }>
    }
  }
  model: string
}

export interface ResponseMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ResponsesAdapter {
  complete(messages: ResponseMessage[]): Promise<string>
}

/**
 * Creates a Responses API adapter for extraction, eval, and legacy fallback paths.
 */
export function createResponsesAdapter(options: ResponsesAdapterOptions): ResponsesAdapter {
  return {
    async complete(messages: ResponseMessage[]) {
      const response = await options.client.responses.create({
        model: options.model,
        input: messages,
      })

      return response.output_text.trim()
    },
  }
}
