// Shared UI types for the Chatty concierge surface.

export type HarnessTrace = {
  sdk?: {
    runStatus?: string
    outputValidated?: boolean
    failureKind?: string
  }
  llm?: {
    model?: string
    calls?: number
    callBudget?: number
    inputCacheHitTokens?: number
    inputCacheMissTokens?: number
    inputCacheHitRatio?: number
    outputTokens?: number
    totalTokens?: number
    estimatedCostCny?: number
    operations?: string[]
    warnings?: string[]
  }
  task?: {
    kind?: string
    goal?: string
    terminality?: string
  }
  action?: {
    action?: string
    toolName?: string
    toolArgs?: Record<string, unknown>
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
  runId: string
  sessionId: string
  status: string
  terminality: string
  harnessTrace?: HarnessTrace
}
