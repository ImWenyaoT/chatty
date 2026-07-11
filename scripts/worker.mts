import { randomUUID } from 'node:crypto'
import { getRepos } from '../apps/web/lib/db.ts'
import {
  recoverCustomerServiceTurns,
  runCustomerServiceTurn,
} from '../apps/web/lib/customer-service-turn.ts'
import { runMemoryConsolidation, runMemoryExtraction } from '../apps/web/lib/memory-pipeline.ts'

const workerId = process.env.CHATTY_WORKER_ID ?? `worker-${randomUUID()}`
const pollMs = Number(process.env.CHATTY_JOB_POLL_MS || 1_000)
const leaseMs = Number(process.env.CHATTY_JOB_LEASE_MS || 60_000)
const heartbeatMs = Number(process.env.CHATTY_JOB_HEARTBEAT_MS || 20_000)
const retryDelays = [60_000, 5 * 60_000, 30 * 60_000]
const once = process.argv.includes('--once')

/** Processes one leased background job and persists its terminal or retry state. */
async function processOne(): Promise<boolean> {
  const repos = getRepos()
  const now = new Date().toISOString()
  const job = repos.control.claimDueJob(workerId, now, leaseMs)
  if (!job) return false
  const jobAbort = new AbortController()
  const heartbeat = setInterval(() => {
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
    if (!repos.control.heartbeatJob(job.id, workerId, leaseExpiresAt)) jobAbort.abort('lease_lost')
  }, heartbeatMs)
  try {
    if (job.type === 'memory_extract') {
      const payload = asObject(job.payload)
      const result = await runMemoryExtraction({
        control: repos.control,
        traces: repos.traces,
        memory: repos.memory,
        sessionId: String(payload.sessionId ?? ''),
        customerId: job.customerId ?? '',
        conversationId: job.conversationId ?? '',
        productId: String(payload.productId ?? 'general'),
        id: (prefix) => `${prefix}_${randomUUID()}`,
      })
      if (jobAbort.signal.aborted) throw new Error('job lease lost')
      repos.control.finishJob(
        job.id,
        result.produced ? 'succeeded' : 'succeeded_no_output',
        result,
        workerId,
      )
      if (result.produced && job.customerId) {
        repos.control.enqueueJob({
          id: `job_${randomUUID()}`,
          type: 'memory_consolidate',
          customerId: job.customerId,
          payload: {},
          dueAt: new Date().toISOString(),
          idempotencyKey: `memory-consolidate:${job.customerId}:${new Date().toISOString().slice(0, 10)}`,
        })
      }
    } else if (job.type === 'memory_consolidate') {
      const result = await runMemoryConsolidation({
        control: repos.control,
        memory: repos.memory,
        customerId: job.customerId ?? '',
      })
      if (jobAbort.signal.aborted) throw new Error('job lease lost')
      repos.control.finishJob(
        job.id,
        result.promoted ? 'succeeded' : 'succeeded_no_output',
        result,
        workerId,
      )
    } else {
      const payload = asObject(job.payload)
      const response = await runCustomerServiceTurn({
        customerId: job.customerId ?? 'system',
        conversationId: job.conversationId,
        question: `系统到期跟进：${String(payload.reason ?? '请继续跟进当前租赁事项')}`,
      })
      repos.control.linkJobRun(job.id, response.runId)
      if (jobAbort.signal.aborted) throw new Error('job lease lost')
      repos.control.appendOutbox({
        id: `out_${randomUUID()}`,
        conversationId: job.conversationId ?? '',
        runId: response.runId,
        payload: { reply: response.reply, sourceJobId: job.id },
        idempotencyKey: `outbox:${job.id}`,
      })
      repos.control.finishJob(job.id, 'succeeded', { traceId: response.traceId }, workerId)
    }
    return true
  } catch (error) {
    const delay = retryDelays[Math.min(job.attempts - 1, retryDelays.length - 1)]
    repos.control.failJob(
      job.id,
      String(error),
      new Date(Date.now() + delay).toISOString(),
      workerId,
    )
    return true
  } finally {
    clearInterval(heartbeat)
  }
}

/** Narrows a persisted JSON payload to an object for job dispatch. */
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

let keepPolling = true
getRepos().control.releaseInterruptedConversationEvents()
await recoverCustomerServiceTurns({ repos: getRepos() })
do {
  const processed = await processOne()
  if (once) keepPolling = false
  if (!processed && keepPolling) await new Promise((resolve) => setTimeout(resolve, pollMs))
} while (keepPolling)
