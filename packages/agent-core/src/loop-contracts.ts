import type {
  AgentSessionStatus,
  AgentStepResult,
  ConversationEvent,
  JsonValue,
  MemorySnapshot,
} from '@rental/shared'

export interface AgentContext {
  event: ConversationEvent
  memory: MemorySnapshot
  /**
   * Status of the session this step runs in. Fed to the safety policy so a
   * closed session denies side-effecting tools (policy deny-all on closed).
   * Defaults to 'active' when the caller does not supply it.
   */
  sessionStatus?: AgentSessionStatus
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

export type { JsonValue }
