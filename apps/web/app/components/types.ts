// Shared UI types for the Chatty concierge surface.

export type HarnessTrace = {
  task?: {
    kind?: string
    goal?: string
    terminality?: string
  }
  action?: {
    action?: string
    toolName?: string
  }
  context?: {
    fragments?: Array<{
      kind?: string
      label?: string
      content?: string
    }>
  }
  toolCalls?: Array<{
    toolName?: string
    risk?: string
    approvalRequired?: boolean
  }>
  toolResults?: unknown[]
}

/** Shape returned by POST /api/playground. */
export type PlaygroundResponse = {
  reply: string
  traceId: string
  sessionId: string
  status: string
  terminality: string
  harnessTrace?: HarnessTrace
}
