import type {
  AgentStepResult,
  ConversationEvent,
  MemorySnapshot,
  RuntimeTool,
} from '@rental/shared'

export interface AgentContext {
  event: ConversationEvent
  memory: MemorySnapshot
  tools: RuntimeTool[]
}

export interface AgentLoopRunner {
  runStep(context: AgentContext): Promise<AgentStepResult>
}

/**
 * Builds a conservative no-op step result for skeleton wiring and tests.
 */
export function createWaitingForUserResult(event: ConversationEvent): AgentStepResult {
  return {
    sessionId: event.conversationId,
    traceId: event.traceId ?? event.eventId,
    terminality: 'reply_and_wait',
    toolCalls: [],
    nextStatus: 'waiting_for_user',
  }
}
