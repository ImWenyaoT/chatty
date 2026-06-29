import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseFormatTextConfig,
  ResponseFunctionToolCall,
  ResponseInput,
} from 'openai/resources/responses/responses'
import { openai } from './openai.js'

export interface ResponseMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CreateTextResponseOptions {
  model: string
  instructions?: string
  input: string | ResponseInput | ResponseMessage[]
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

export interface CreateJsonResponseOptions extends CreateTextResponseOptions {
  format: ResponseFormatTextConfig
}

export interface CreateFunctionCallOptions extends CreateTextResponseOptions {
  tool: FunctionTool
}

/**
 * Calls the Responses API and returns the SDK's final text helper.
 */
export async function createTextResponse(options: CreateTextResponseOptions): Promise<string> {
  const response = await openai.responses.create(buildResponseParams(options))
  return response.output_text.trim()
}

/**
 * Calls the Responses API with structured text output and returns parsed JSON.
 */
export async function createJsonResponse<T extends object>(options: CreateJsonResponseOptions): Promise<T> {
  const response = await openai.responses.create(buildResponseParams({
    ...options,
    text: { format: options.format },
  }))
  const content = response.output_text.trim() || '{}'
  return JSON.parse(content) as T
}

/**
 * Calls the Responses API with a forced function tool and returns parsed arguments.
 */
export async function createFunctionCall<T extends object>(options: CreateFunctionCallOptions): Promise<T | null> {
  const response = await openai.responses.create(buildResponseParams({
    ...options,
    tools: [options.tool],
    tool_choice: { type: 'function', name: options.tool.name },
  }))
  const call = response.output.find((item): item is ResponseFunctionToolCall =>
    item.type === 'function_call' && item.name === options.tool.name,
  )
  if (!call) return null
  return JSON.parse(call.arguments) as T
}

/**
 * Builds the shared non-streaming Responses payload from chat-era options.
 */
function buildResponseParams(options: CreateTextResponseOptions & Partial<ResponseCreateParamsNonStreaming>): ResponseCreateParamsNonStreaming {
  return {
    model: options.model,
    input: options.input as string | ResponseInput,
    instructions: options.instructions,
    temperature: options.temperature,
    top_p: options.topP,
    max_output_tokens: options.maxOutputTokens,
    text: options.text,
    tools: options.tools,
    tool_choice: options.tool_choice,
  }
}
