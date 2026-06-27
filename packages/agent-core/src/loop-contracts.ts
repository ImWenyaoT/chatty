import type {
  AgentStepResult,
  ConversationEvent,
  JsonValue,
  MemorySnapshot,
} from '@rental/shared'

export interface AgentContext {
  event: ConversationEvent
  memory: MemorySnapshot
}

export interface AgentLoopRunner {
  runStep(context: AgentContext): Promise<AgentStepResult>
}

/**
 * Builds a conservative no-op step result. Kept as a safety fallback for
 * tests and paths that intentionally produce no reply (e.g. tool_result events
 * processed out of band).
 */
export function createWaitingForUserResult(event: ConversationEvent, reply?: string): AgentStepResult {
  return {
    sessionId: event.conversationId,
    traceId: event.traceId ?? event.eventId,
    terminality: 'reply_and_wait',
    reply,
    toolCalls: [],
    nextStatus: 'waiting_for_user',
  }
}

/** Max decision iterations within a single bounded request step (PRD §8.2). */
export const MAX_STEPS = 3

export type { JsonValue }
