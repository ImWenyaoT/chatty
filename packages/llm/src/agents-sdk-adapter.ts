import {
  Agent,
  OpenAIChatCompletionsModel,
  run,
  setTracingDisabled,
  tool,
  type FunctionTool,
  type Model,
} from '@openai/agents'
import OpenAI from 'openai'
import { readLlmEnv } from './client-from-env.js'
import { agentsSdkUsageToTelemetry, type ChatCompletionTelemetry } from './usage-telemetry.js'

export type AgentsSdkRuntimeTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  needsApproval?: boolean
  execute(input: unknown): Promise<unknown> | unknown
}

export type AgentsSdkToolLoopOptions = {
  instructions: string
  model: Model
  /** 用于遥测记录的模型名（Model 对象本身不带名字）。 */
  modelName?: string
  name?: string
  tools?: AgentsSdkRuntimeTool[]
  maxTurns?: number
  /** 每次 SDK model 调用回传一条归一化遥测（含 KV cache 命中）。 */
  telemetry?: (record: ChatCompletionTelemetry) => void
}

/**
 * Builds the Agents SDK Chat Completions model around DeepSeek's OpenAI-format
 * endpoint. The SDK provides the model abstraction; Chatty keeps DeepSeek as
 * the only configured model lane.
 */
export function createDeepSeekAgentsModelFromEnv(env: NodeJS.ProcessEnv = process.env): Model {
  const { apiKey, baseURL, chatModel } = readLlmEnv(env)
  const client = new OpenAI({ apiKey, baseURL })
  return new OpenAIChatCompletionsModel(client as never, chatModel, {
    strictFeatureValidation: true,
  })
}

/**
 * Converts a Chatty runtime tool definition into an OpenAI Agents SDK function
 * tool so schema exposure, invocation, and approval semantics are SDK-owned.
 */
export function toAgentsSdkFunctionTool(definition: AgentsSdkRuntimeTool): FunctionTool {
  return tool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as never,
    strict: false,
    needsApproval: definition.needsApproval ?? false,
    execute: async (input) => {
      const result = await definition.execute(input)
      return typeof result === 'string' ? result : JSON.stringify(result)
    },
  })
}

/**
 * Creates an SDK-backed compose loop. The SDK owns model/tool orchestration;
 * callers still own business task scheduling, prompt construction, trace
 * persistence, and DeepSeek fallback policy.
 */
export function createAgentsSdkToolLoopFn(options: AgentsSdkToolLoopOptions) {
  setTracingDisabled(true)
  const agent = new Agent({
    name: options.name ?? 'Chatty customer-service composer',
    instructions: options.instructions,
    model: options.model,
    tools: (options.tools ?? []).map(toAgentsSdkFunctionTool),
    modelSettings: {
      parallelToolCalls: false,
    },
  })

  const modelName = options.modelName ?? 'deepseek-v4-pro'

  return async (input: string): Promise<string> => {
    const result = await run(agent, input, {
      maxTurns: options.maxTurns ?? 4,
    })
    if (options.telemetry) {
      for (const response of result.rawResponses ?? []) {
        options.telemetry(agentsSdkUsageToTelemetry(modelName, response.usage))
      }
    }
    return String(result.finalOutput ?? '')
  }
}

/**
 * Convenience builder for production wiring: DeepSeek model from env plus SDK
 * tool loop from the supplied harness instructions/tools.
 */
export function createDeepSeekAgentsSdkToolLoop(options: Omit<AgentsSdkToolLoopOptions, 'model'>) {
  return createAgentsSdkToolLoopFn({
    ...options,
    model: createDeepSeekAgentsModelFromEnv(),
    modelName: options.modelName ?? readLlmEnv().chatModel,
  })
}
