import type { BackgroundJob, ControlPlaneRepository, OutboxMessage, WorkflowRun } from '@rental/db'

export type WorkflowDisplayState =
  | 'queued'
  | 'running'
  | 'cancelled'
  | 'handed_off'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'waiting'
  | 'unknown'

export interface ConversationControlView {
  queueDepth: number
  workflow: Partial<WorkflowRun> & { displayState: WorkflowDisplayState; leaseExpired: boolean }
  workflowEvents: ReturnType<ControlPlaneRepository['listRunEvents']>
}

export type ConversationControlApiView = ConversationControlView & {
  checkpoint?: { version: number; tokenBefore: number; tokenAfter: number; summary: unknown }
  memories: Array<{ id: string; category: string; key: string; status: string; usageCount: number }>
}

export interface OperationsControlView {
  jobs: Array<
    BackgroundJob & {
      retryDelayMs?: number
      events: ReturnType<ControlPlaneRepository['listJobEvents']>
    }
  >
  outbox: OutboxMessage[]
  metrics: {
    workflowFailures: number
    compactions: number
    compactionFailures: number
    memoryNoOps: number
    retryRate: number | null
    followupLatencyMs: number | null
  }
}

/** Builds the authoritative workflow and queue view for one Customer Service conversation. */
export function buildConversationControlView(
  control: ControlPlaneRepository,
  input: { conversationId: string; runId?: string; now?: string },
): ConversationControlView {
  const now = input.now ?? new Date().toISOString()
  const run = input.runId ? control.getRun(input.runId) : undefined
  const leaseExpired = Boolean(run?.leaseExpiresAt && run.leaseExpiresAt < now)
  const queueDepth = input.conversationId
    ? control.countQueuedConversationEvents(input.conversationId)
    : 0
  return {
    queueDepth,
    workflow: run
      ? { ...run, displayState: displayWorkflowState(run, leaseExpired), leaseExpired }
      : { displayState: queueDepth > 0 ? 'queued' : 'unknown', leaseExpired: false },
    workflowEvents: run ? control.listRunEvents(run.id) : [],
  }
}

/** Builds jobs, delivery evidence, and aggregate control-plane health from durable state. */
export function buildOperationsControlView(
  control: ControlPlaneRepository,
  now = new Date().toISOString(),
): OperationsControlView {
  const jobs = control.listJobs().map((job) => {
    const retryDelayMs =
      job.status === 'pending' && job.attempts > 0
        ? Math.max(0, new Date(job.dueAt).getTime() - new Date(now).getTime())
        : undefined
    return { ...job, retryDelayMs, events: control.listJobEvents(job.id) }
  })
  const jobHealth = control.aggregateJobHealth()
  return {
    jobs,
    outbox: control.listOutbox(),
    metrics: {
      workflowFailures: control.countRunsByStatus('failed'),
      compactions: control.countRunEventsByType('compaction_completed'),
      compactionFailures: control.countRunEventsByType('compaction_failed'),
      memoryNoOps: jobHealth.memoryNoOps,
      retryRate: jobHealth.attemptedJobs ? jobHealth.retriedJobs / jobHealth.attemptedJobs : null,
      followupLatencyMs: jobHealth.followupLatencyMs,
    },
  }
}

/** Maps durable workflow state to the operator-facing control-plane vocabulary. */
function displayWorkflowState(run: WorkflowRun, leaseExpired: boolean): WorkflowDisplayState {
  if (leaseExpired && ['running', 'paused'].includes(run.status)) return 'recovering'
  if (run.status === 'waiting_for_handoff') return 'handed_off'
  if (
    run.status === 'paused' ||
    run.status === 'waiting_for_user' ||
    run.status === 'waiting_for_approval'
  )
    return 'waiting'
  return run.status
}
