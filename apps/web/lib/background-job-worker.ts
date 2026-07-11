import type { BackgroundJob, ControlPlaneRepository } from '@rental/db'
import type { JsonValue } from '@rental/shared'

export interface JobExecutionResult {
  status?: 'succeeded' | 'succeeded_no_output'
  event?: JsonValue
  followup?: { runId: string; payload: JsonValue }
}

export interface BackgroundJobExecutors {
  memoryExtract(job: BackgroundJob, signal: AbortSignal): Promise<JobExecutionResult>
  memoryConsolidate(job: BackgroundJob, signal: AbortSignal): Promise<JobExecutionResult>
  scheduledFollowup(job: BackgroundJob, signal: AbortSignal): Promise<JobExecutionResult>
}

export interface DispatchBackgroundJobOptions {
  control: ControlPlaneRepository
  executors: BackgroundJobExecutors
  workerId: string
  now?: () => Date
  leaseMs?: number
  heartbeatMs?: number
  retryDelaysMs?: readonly number[]
}

/** Claims and dispatches at most one background job through its durable fencing boundary. */
export async function dispatchBackgroundJob(
  options: DispatchBackgroundJobOptions,
): Promise<boolean> {
  const now = options.now ?? (() => new Date())
  const leaseMs = options.leaseMs ?? 60_000
  const heartbeatMs = options.heartbeatMs ?? 20_000
  const retryDelays = options.retryDelaysMs ?? [60_000, 5 * 60_000, 30 * 60_000]
  const job = options.control.claimDueJob(options.workerId, now().toISOString(), leaseMs)
  if (!job) return false

  const abort = new AbortController()
  const heartbeat = setInterval(() => {
    const observedAt = now()
    const leaseExpiresAt = new Date(observedAt.getTime() + leaseMs).toISOString()
    if (
      !options.control.heartbeatJob(
        job.id,
        options.workerId,
        job.claimFence,
        leaseExpiresAt,
        observedAt.toISOString(),
      )
    ) {
      options.control.appendJobEvent(job.id, 'heartbeat_lost', {
        workerId: options.workerId,
        claimFence: job.claimFence,
      })
      abort.abort(new Error('background job claim lost or cancelled'))
    }
  }, heartbeatMs)

  try {
    const executor = selectExecutor(options.executors, job.type)
    const result = await executor(job, abort.signal)
    if (abort.signal.aborted) return true

    if (job.type === 'scheduled_followup') {
      if (!result.followup) throw new Error('scheduled follow-up produced no delivery result')
      options.control.completeFollowup(
        job.id,
        options.workerId,
        job.claimFence,
        {
          id: `outbox:${job.id}`,
          conversationId: job.conversationId ?? '',
          runId: result.followup.runId,
          payload: { ...asObject(result.followup.payload), sourceJobId: job.id },
          idempotencyKey: `outbox:${job.id}`,
        },
        result.event,
      )
    } else {
      options.control.finishJob(
        job.id,
        result.status ?? 'succeeded',
        result.event,
        options.workerId,
        job.claimFence,
      )
    }
    return true
  } catch (error) {
    if (!abort.signal.aborted) {
      const delay = retryDelays[Math.min(job.attempts - 1, retryDelays.length - 1)] ?? 0
      options.control.failJob(
        job.id,
        String(error),
        new Date(now().getTime() + delay).toISOString(),
        options.workerId,
        job.claimFence,
      )
    }
    return true
  } finally {
    clearInterval(heartbeat)
  }
}

/** Selects the executor owned by the claimed background-job type. */
function selectExecutor(
  executors: BackgroundJobExecutors,
  type: BackgroundJob['type'],
): BackgroundJobExecutors[keyof BackgroundJobExecutors] {
  if (type === 'memory_extract') return executors.memoryExtract
  if (type === 'memory_consolidate') return executors.memoryConsolidate
  return executors.scheduledFollowup
}

/** Narrows a JSON payload to the object shape required by the outbox envelope. */
function asObject(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : { value }
}
