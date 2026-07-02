import OpenAI from 'openai'
import { createOpenAiClientFromEnv, readLlmEnv } from './client-from-env.js'

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
  /**
   * Asks the model for a single JSON object. Falls back to parsing the first
   * {...} block in the reply so providers that don't strictly honour
   * response_format still work (e.g. some OpenAI-compatible endpoints).
   */
  completeJson<T = unknown>(messages: ChatCompletionMessage[]): Promise<T>
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

    async completeJson<T = unknown>(messages: ChatCompletionMessage[]) {
      const response = await options.client.chat.completions.create({
        model: options.model,
        messages,
        // Hint only; non-strict providers ignore this and we still parse below.
        response_format: { type: 'json_object' },
      })

      const raw = response.choices[0]?.message?.content?.trim() ?? ''
      return parseJsonObject<T>(raw)
    },
  }
}

/**
 * Convenience builder that wires the adapter from the shared env config, so
 * agent-core and route handlers do not each construct an OpenAI client.
 */
export function createChatCompletionsAdapterFromEnv(): ChatCompletionsAdapter {
  const { chatModel } = readLlmEnv()
  return createChatCompletionsAdapter({
    client: createOpenAiClientFromEnv(),
    model: chatModel,
  })
}

/**
 * 把模型回复解析成 JSON 对象：优先整体 JSON.parse；失败后回退到正则提取
 * 首个 { 到最后一个 } 的块（兼容回复里夹杂说明文字 / markdown 代码块的
 * 非严格 provider）；仍不可解析时抛错并附上回复片段便于排查。
 */
export function parseJsonObject<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      return JSON.parse(match[0]) as T
    }
    throw new Error(`chat-completions: could not parse JSON from model reply: ${raw.slice(0, 120)}`)
  }
}
