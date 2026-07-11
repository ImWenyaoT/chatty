import {
  ConversationBusyError,
  type ControlPlaneRepository,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@rental/db'
import type { JsonValue } from '@rental/shared'

const activeAbortControllers = new Map<string, { controller: AbortController; owner: string }>()

/** Coordinates one durable active run per conversation and emits its ordered lifecycle events. */
export class HarnessRunController {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly owner = `worker-${crypto.randomUUID()}`,
  ) {}

  /** Starts a new durable workflow or observes its idempotent predecessor. */
  start(input: {
    runId: string
    sessionId: string
    conversationId: string
    idempotencyKey: string
    event: JsonValue
  }): { run: WorkflowRun; signal: AbortSignal; replayed: boolean } {
    try {
      const existing = this.repository.getRunByIdempotencyKey(input.idempotencyKey)
      if (existing) {
        return { run: existing, signal: AbortSignal.abort('idempotent_replay'), replayed: true }
      }
      const run = this.repository.startRun({
        id: input.runId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        idempotencyKey: input.idempotencyKey,
      })
      const replayed = false
      this.repository.appendRunEvent(run.id, 'scheduled', input.event)
      const controller = new AbortController()
      activeAbortControllers.set(run.id, { controller, owner: this.owner })
      const claimed = this.repository.claimRun(run.id, this.owner, new Date().toISOString())
      if (!claimed) throw new Error(`workflow run could not be claimed: ${run.id}`)
      return { run: claimed, signal: controller.signal, replayed }
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        this.repository.enqueueConversationEvent(
          input.conversationId,
          input.idempotencyKey,
          input.event,
        )
      }
      throw error
    }
  }

  /** Applies one owner-fenced workflow transition and records its ordered event. */
  transition(runId: string, status: WorkflowRunStatus, payload: JsonValue = {}): WorkflowRun {
    const details = asObject(payload)
    const failureKind = typeof details.failureKind === 'string' ? details.failureKind : undefined
    const run = this.repository.transitionRun(runId, status, failureKind, this.owner)
    this.repository.appendRunEvent(runId, 'state_changed', { status, ...details })
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      activeAbortControllers.delete(runId)
    }
    return run
  }

  /** Takes execution ownership of one queued or lease-expired workflow after a restart. */
  recover(runId: string): { run: WorkflowRun; signal: AbortSignal } {
    const controller = new AbortController()
    const run = this.repository.claimRun(runId, this.owner, new Date().toISOString())
    if (!run) throw new Error(`workflow run is not recoverable: ${runId}`)
    activeAbortControllers.set(runId, { controller, owner: this.owner })
    this.repository.appendRunEvent(runId, 'recovered', { owner: this.owner })
    return { run, signal: controller.signal }
  }

  /** Appends one observable lifecycle event for the active workflow. */
  event(runId: string, type: string, payload: JsonValue = {}): void {
    this.repository.appendRunEvent(runId, type, payload)
  }

  /** Renews the active workflow lease while model or tool execution is still running. */
  heartbeat(runId: string): boolean {
    const renewed = this.repository.heartbeatRun(runId, this.owner, new Date().toISOString())
    if (!renewed) {
      activeAbortControllers.get(runId)?.controller.abort('workflow_lease_lost')
    }
    return renewed
  }

  /** Stores the public Customer Service Turn result for idempotent replay. */
  saveResult(runId: string, result: JsonValue): boolean {
    return this.repository.saveRunResult(runId, this.owner, result)
  }

  /** Durably requests cancellation, then wakes any same-process signal as an optimization. */
  cancel(runId: string): WorkflowRun {
    const run = this.repository.requestRunCancellation(runId)
    const active = activeAbortControllers.get(runId)
    if (active?.owner === this.owner) active.controller.abort(new Error('workflow cancelled'))
    return run
  }

  /** Aborts this worker's shared signal after observing durable cancellation. */
  observeCancellation(runId: string): boolean {
    const run = this.repository.getRun(runId)
    if (!run?.cancelRequestedAt) return false
    activeAbortControllers
      .get(runId)
      ?.controller.abort(new Error(run.cancelReason ?? 'workflow cancelled'))
    return true
  }

  /** Resumes a durable human handoff only for the worker that acquires the next lease. */
  resumeHandoff(runId: string): { run: WorkflowRun; signal: AbortSignal } {
    const current = this.repository.getRun(runId)
    if (current?.status !== 'waiting_for_handoff') {
      throw new Error(`workflow run is not waiting for handoff: ${runId}`)
    }
    const run = this.repository.resumeHandoff(runId, this.owner, new Date().toISOString())
    if (!run) throw new Error(`workflow handoff could not be resumed: ${runId}`)
    const controller = new AbortController()
    activeAbortControllers.set(runId, { controller, owner: this.owner })
    this.repository.appendRunEvent(runId, 'handoff_resumed', { owner: this.owner })
    return { run, signal: controller.signal }
  }
}

/** Narrows a JSON payload to the object shape used by workflow events. */
function asObject(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
