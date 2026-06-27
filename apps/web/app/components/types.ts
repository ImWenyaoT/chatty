// Shared UI types for the Chatty concierge surface.

export type Role = 'user' | 'agent' | 'system'

/** One rendered turn in the conversation. Agent turns carry loop metadata. */
export type Turn = {
  id: number
  role: Role
  text: string
  /** system turns: render as an error (dashed → wine). */
  error?: boolean
  /** agent turns: the loop returned handoff_and_wait / waiting_for_human. */
  handoff?: boolean
  /** agent turns: loop trace fields, surfaced in the collapsible detail. */
  traceId?: string
  sessionId?: string
  status?: string
  terminality?: string
}

/** Shape returned by POST /api/playground. */
export type PlaygroundResponse = {
  reply: string
  traceId: string
  sessionId: string
  status: string
  terminality: string
}
