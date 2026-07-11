import type {
  KnowledgeRepository,
  MemoryRepository,
  SessionRepository,
  TraceRepository,
  ControlPlaneRepository,
} from '@rental/db'
import { createDefaultToolRegistry, runCustomerServiceHarnessStep } from '@rental/agent-core'
import type { JsonValue, LegacyChatInput } from '@rental/shared'
import type { HarnessTrace } from '../app/components/types'
import { getRepos, newId } from './db'
import { createPlaygroundLlmRuntime } from './llm'
import { HarnessRunController } from './harness-run-controller'
import { compactContextIfNeeded, projectContext } from './context-control'

export type CustomerServiceTurnRepos = {
  sessions: SessionRepository
  traces: TraceRepository
  memory: MemoryRepository
  knowledge: KnowledgeRepository
  control: ControlPlaneRepository
}

export type CustomerServiceTurnResponse = {
  reply: string
  traceId: string
  sessionId: string
  status: string
  terminality: string
  harnessTrace: HarnessTrace
  runId: string
}

type CustomerServiceTurnLlmRuntime = ReturnType<typeof createPlaygroundLlmRuntime>

type CustomerServiceTurnOptions = {
  repos?: CustomerServiceTurnRepos
  idGenerator?: (prefix: string) => string
  now?: () => string
  llmRuntimeFactory?: () => CustomerServiceTurnLlmRuntime
  idempotencyKey?: string
  queuedTurnDispatcher?: (input: LegacyChatInput) => Promise<void>
  recoverRunId?: string
  cancellationPollMs?: number
  signal?: AbortSignal
}

export class CustomerServiceProviderError extends Error {
  constructor(cause: unknown) {
    super('DeepSeek Agents SDK run failed', { cause })
    this.name = 'CustomerServiceProviderError'
  }
}

export class CustomerServiceCancelledError extends Error {
  constructor() {
    super('Customer Service Turn cancelled')
    this.name = 'CustomerServiceCancelledError'
  }
}

/**
 * Runs one seller-side Customer Service Turn from parsed input. This module is
 * the product use-case seam: it owns session creation, event shaping, harness
 * execution, trace persistence, and continuity memory writes; HTTP routes stay
 * as adapters.
 */
export async function runCustomerServiceTurn(
  input: LegacyChatInput,
  options: CustomerServiceTurnOptions = {},
): Promise<CustomerServiceTurnResponse> {
  const repos = options.repos ?? getRepos()
  const id = options.idGenerator ?? newId
  const now = options.now ?? (() => new Date().toISOString())
  const conversationId =
    input.conversationId ?? `${input.customerId}:${input.productId ?? 'general'}`

  let session = repos.sessions.findByConversation(conversationId)
  if (!session) {
    session = repos.sessions.create({
      id: id('sess'),
      customerId: input.customerId,
      conversationId,
      productId: input.productId,
    })
  }

  const traceId = id('tr')
  const event = {
    eventId: id('evt'),
    type: 'user_message' as const,
    customerId: input.customerId,
    conversationId,
    productId: input.productId,
    source: 'customer' as const,
    payload: createTurnPayload(input),
    occurredAt: now(),
    traceId,
  }
  const runId = options.recoverRunId ?? id('run')
  const runController = new HarnessRunController(repos.control)
  const started = options.recoverRunId
    ? { ...runController.recover(runId), replayed: false }
    : runController.start({
        runId,
        sessionId: session.id,
        conversationId,
        idempotencyKey: options.idempotencyKey ?? event.eventId,
        event: event as unknown as JsonValue,
      })
  if (started.replayed) {
    if (started.run.status === 'completed' && started.run.result) {
      return started.run.result as unknown as CustomerServiceTurnResponse
    }
    throw new Error(`workflow run already in progress: ${started.run.id}`)
  }
  /** Bridges an owning background-job cancellation into the durable workflow state. */
  const externalCancellation = () =>
    repos.control.requestRunCancellation(runId, 'background_job_cancelled')
  options.signal?.addEventListener('abort', externalCancellation, { once: true })
  const heartbeat = setInterval(() => runController.heartbeat(runId), 20_000)
  heartbeat.unref()
  const cancellationPoll = setInterval(
    () => runController.observeCancellation(runId),
    options.cancellationPollMs ?? 100,
  )
  cancellationPoll.unref()
  try {
    const snapshot = repos.memory.snapshot({
      customerId: input.customerId,
      conversationId,
      productId: input.productId,
    })
    const promotedMemories = repos.control.listMemoryCandidates(input.customerId, 'promoted')
    const checkpointBefore = repos.control.latestCheckpoint(conversationId)
    if (promotedMemories.length) {
      repos.control.markMemoryUsed(promotedMemories.map((memory) => memory.id))
    }
    let projectedSnapshot = projectContext({
      snapshot,
      checkpoint: checkpointBefore,
      memories: promotedMemories,
    })
    const compacted = await compactContextIfNeeded({
      control: repos.control,
      snapshot: projectedSnapshot,
      conversationId,
      throughTraceId: traceId,
      checkpointId: id('cp'),
      workflowState: session.currentStep,
    })
    if (compacted.checkpoint) {
      projectedSnapshot = projectContext({
        snapshot,
        checkpoint: compacted.checkpoint,
        memories: promotedMemories,
      })
      runController.event(runId, 'compacted', {
        checkpointId: compacted.checkpoint.id,
        tokenBefore: compacted.tokenBefore,
        tokenAfter: compacted.checkpoint.tokenAfter,
      })
    }
    runController.event(runId, 'context_built', {
      estimatedTokens: compacted.tokenBefore,
      compactTriggered: compacted.triggered,
      checkpointVersion: compacted.checkpoint?.version ?? checkpointBefore?.version ?? 0,
      memoryIds: promotedMemories.map((memory) => memory.id),
    })
    let llm: CustomerServiceTurnLlmRuntime
    try {
      llm = options.llmRuntimeFactory ? options.llmRuntimeFactory() : createPlaygroundLlmRuntime()
    } catch (error) {
      throwIfTurnCancelled(started.signal, repos.control, runId)
      repos.traces.append({
        id: traceId,
        sessionId: session.id,
        eventType: 'evaluation_failed',
        input: { question: input.question },
        output: { failureKind: 'configuration_error', message: String(error) },
        toolCalls: [],
        references: [],
      })
      repos.sessions.update(session.id, { status: 'failed', currentStep: 'configuration_error' })
      runController.transition(runId, 'failed', { failureKind: 'configuration_error' })
      throw error
    }

    let harness
    try {
      harness = await runCustomerServiceHarnessStep({
        event,
        memory: projectedSnapshot,
        registry: createDefaultToolRegistry(repos.knowledge, {
          scheduleFollowup: (args, capabilityOptions) => {
            capabilityOptions?.signal?.throwIfAborted()
            const job = repos.control.enqueueJob({
              id: id('job'),
              type: 'scheduled_followup',
              conversationId,
              customerId: input.customerId,
              payload: args,
              dueAt: typeof args.dueAt === 'string' ? args.dueAt : now(),
              idempotencyKey: `followup:${conversationId}:${String(args.dueAt)}`,
            })
            return { ok: true, jobId: job.id, dueAt: job.dueAt }
          },
        }),
        sessionStatus: session.status,
        sdkRunner: llm.sdkRunner,
        runId,
        signal: started.signal,
        emitEvent: (type, payload = {}) => runController.event(runId, type, payload),
      })
    } catch (error) {
      throwIfTurnCancelled(started.signal, repos.control, runId)
      repos.traces.append({
        id: traceId,
        sessionId: session.id,
        eventType: 'evaluation_failed',
        input: { question: input.question },
        output: { failureKind: 'provider_or_output_validation', message: String(error) },
        toolCalls: [],
        references: [],
      })
      repos.sessions.update(session.id, { status: 'failed', currentStep: 'provider_error' })
      runController.transition(runId, 'failed', { failureKind: 'provider_or_output_validation' })
      throw new CustomerServiceProviderError(error)
    }
    const result = harness.step
    const harnessTrace = { ...harness.trace, llm: llm.summary() } as unknown as HarnessTrace

    repos.traces.append({
      id: traceId,
      sessionId: session.id,
      eventType: 'agent_reply_sent',
      intent: harness.trace.task.kind,
      action: harness.trace.action.action,
      input: {
        question: input.question,
        harnessContext: harness.trace.context.fragments as unknown as JsonValue,
      },
      output:
        result.reply || result.memoryPatch
          ? {
              ...(result.reply ? { reply: result.reply } : {}),
              ...(result.memoryPatch !== undefined ? { memoryPatch: result.memoryPatch } : {}),
              harnessTrace: harnessTrace as unknown as JsonValue,
            }
          : undefined,
      toolCalls: result.toolCalls,
      references: harness.trace.context.fragments as unknown as JsonValue[],
    })
    repos.sessions.update(session.id, {
      status: result.nextStatus,
      currentStep: result.terminality,
      productId: input.productId,
    })
    if (result.nextStatus === 'waiting_for_human') {
      runController.transition(runId, 'waiting_for_handoff')
      runController.event(runId, 'handoff_requested', { traceId })
    }
    appendTurnContinuity(repos.memory, {
      customerId: input.customerId,
      productId: input.productId ?? 'general',
      conversationId,
      question: input.question,
      reply: result.reply,
    })
    repos.control.scheduleMemoryExtraction({
      id: id('job'),
      conversationId,
      customerId: input.customerId,
      payload: { sessionId: session.id, productId: input.productId ?? 'general' },
      now: now(),
      coolingMs: 24 * 60 * 60 * 1000,
    })

    const response: CustomerServiceTurnResponse = {
      reply: result.reply ?? '',
      traceId,
      sessionId: session.id,
      status: result.nextStatus,
      terminality: result.terminality,
      harnessTrace,
      runId,
    }
    if (result.nextStatus !== 'waiting_for_human') {
      if (!runController.saveResult(runId, response as unknown as JsonValue)) {
        throw new Error(`workflow result could not be persisted: ${runId}`)
      }
      runController.transition(runId, 'completed')
      runController.event(runId, 'completed', { traceId, terminality: result.terminality })
    }

    await drainQueuedTurns(conversationId, repos, options)

    clearInterval(heartbeat)
    clearInterval(cancellationPoll)
    options.signal?.removeEventListener('abort', externalCancellation)
    return response
  } catch (error) {
    clearInterval(heartbeat)
    clearInterval(cancellationPoll)
    options.signal?.removeEventListener('abort', externalCancellation)
    const current = repos.control.getRun(runId)
    if (current && ['queued', 'running', 'paused'].includes(current.status)) {
      repos.sessions.update(session.id, { status: 'failed', currentStep: 'control_plane_error' })
      runController.transition(runId, 'failed', { failureKind: 'control_plane_error' })
    }
    if (current?.status === 'cancelled') {
      await drainQueuedTurns(conversationId, repos, options)
      throw new CustomerServiceCancelledError()
    }
    throw error
  }
}

/** Normalizes any observed durable or in-process cancellation into the public turn error. */
function throwIfTurnCancelled(
  signal: AbortSignal,
  control: ControlPlaneRepository,
  runId: string,
): void {
  if (signal.aborted || control.getRun(runId)?.cancelRequestedAt) {
    throw new CustomerServiceCancelledError()
  }
}

/** Dispatches durable FIFO inputs after any terminal workflow outcome. */
async function drainQueuedTurns(
  conversationId: string,
  repos: CustomerServiceTurnRepos,
  options: CustomerServiceTurnOptions,
): Promise<void> {
  let queuedEntry = repos.control.claimConversationEvent(conversationId)
  while (queuedEntry) {
    const queuedInput = inputFromQueuedEvent(queuedEntry.event)
    if (queuedInput) {
      try {
        if (options.queuedTurnDispatcher) {
          await options.queuedTurnDispatcher(queuedInput)
        } else {
          await runCustomerServiceTurn(queuedInput, {
            ...options,
            idempotencyKey: queuedEventId(queuedEntry.event),
          })
        }
        repos.control.completeConversationEvent(queuedEntry.id)
      } catch (error) {
        repos.control.releaseConversationEvent(queuedEntry.id)
        throw error
      }
    } else {
      repos.control.completeConversationEvent(queuedEntry.id)
    }
    if (!options.queuedTurnDispatcher) break
    queuedEntry = repos.control.claimConversationEvent(conversationId)
  }
}

/** Recovers expired Customer Service Turns from durable scheduled events after process startup. */
export async function recoverCustomerServiceTurns(
  options: CustomerServiceTurnOptions & { now?: () => string } = {},
): Promise<string[]> {
  const repos = options.repos ?? getRepos()
  const now = options.now ?? (() => new Date().toISOString())
  const recovered: string[] = []
  for (const run of repos.control.listRecoverableRuns(now())) {
    const scheduled = repos.control
      .listRunEvents(run.id)
      .find((event) => event.type === 'scheduled')
    const input = scheduled ? inputFromQueuedEvent(scheduled.payload) : undefined
    if (!input) continue
    await runCustomerServiceTurn(input, { ...options, repos, recoverRunId: run.id })
    recovered.push(run.id)
  }
  return recovered
}

/** Rebuilds a Customer Service Turn input from one durable queued harness event. */
function inputFromQueuedEvent(event: JsonValue): LegacyChatInput | undefined {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return undefined
  const payload = event.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  if (typeof event.customerId !== 'string' || typeof payload.question !== 'string') return undefined
  return {
    customerId: event.customerId,
    conversationId: typeof event.conversationId === 'string' ? event.conversationId : undefined,
    productId: typeof event.productId === 'string' ? event.productId : undefined,
    question: payload.question,
    imageUrl: typeof payload.imageUrl === 'string' ? payload.imageUrl : undefined,
  }
}

/** Reads the original request identity retained inside a durable queued event. */
function queuedEventId(event: JsonValue): string | undefined {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return undefined
  return typeof event.eventId === 'string' ? event.eventId : undefined
}

/** Builds the event payload consumed by the harness from parsed input. */
function createTurnPayload(input: LegacyChatInput): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = { question: input.question }
  if (input.imageUrl) payload.imageUrl = input.imageUrl
  return payload
}

/** Persists the minimal recent-message continuity needed by the next turn. */
function appendTurnContinuity(
  memory: MemoryRepository,
  input: {
    customerId: string
    productId: string
    conversationId: string
    question: string
    reply?: string
  },
) {
  const turn: JsonValue[] = [{ role: 'user', content: input.question }]
  if (input.reply) turn.push({ role: 'assistant', content: input.reply })
  memory.appendRecentMessages(
    {
      customerId: input.customerId,
      productId: input.productId,
      conversationId: input.conversationId,
    },
    turn,
  )
}
