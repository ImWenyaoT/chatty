import type { AgentStepResult, ConversationEvent, JsonValue } from '@rental/shared'

export interface AgentsSdkRunInput {
  event: ConversationEvent
  instructions: string
  context: Record<string, JsonValue>
}

export interface AgentsSdkRunner {
  run(input: AgentsSdkRunInput): Promise<AgentStepResult>
}

export type AgentsSdkRunFunction = (input: AgentsSdkRunInput) => Promise<AgentStepResult>

/**
 * Creates a thin boundary around OpenAI Agents SDK execution for the worker layer.
 */
export function createAgentsSdkRunner(run: AgentsSdkRunFunction): AgentsSdkRunner {
  return {
    async run(input: AgentsSdkRunInput) {
      return run(input)
    },
  }
}
