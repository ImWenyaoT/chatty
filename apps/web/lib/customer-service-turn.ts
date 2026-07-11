import type {
  KnowledgeRepository,
  MemoryRepository,
  SessionRepository,
  TraceRepository,
} from '@rental/db'
import { createDefaultToolRegistry, runCustomerServiceHarnessStep } from '@rental/agent-core'
import type { JsonValue, LegacyChatInput } from '@rental/shared'
import type { HarnessTrace } from '../app/components/types'
import { getRepos, newId } from './db'
import { createPlaygroundLlmRuntime } from './llm'

export type CustomerServiceTurnRepos = {
  sessions: SessionRepository
  traces: TraceRepository
  memory: MemoryRepository
  knowledge: KnowledgeRepository
}

export type CustomerServiceTurnResponse = {
  reply: string
  traceId: string
  sessionId: string
  status: string
  terminality: string
  harnessTrace: HarnessTrace
}

type CustomerServiceTurnLlmRuntime = ReturnType<typeof createPlaygroundLlmRuntime>

type CustomerServiceTurnOptions = {
  repos?: CustomerServiceTurnRepos
  idGenerator?: (prefix: string) => string
  now?: () => string
  llmRuntimeFactory?: () => CustomerServiceTurnLlmRuntime
}

export class CustomerServiceProviderError extends Error {
  constructor(cause: unknown) {
    super('DeepSeek Agents SDK run failed', { cause })
    this.name = 'CustomerServiceProviderError'
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
  const snapshot = repos.memory.snapshot({
    customerId: input.customerId,
    conversationId,
    productId: input.productId,
  })
  let llm: CustomerServiceTurnLlmRuntime
  try {
    llm = options.llmRuntimeFactory ? options.llmRuntimeFactory() : createPlaygroundLlmRuntime()
  } catch (error) {
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
    throw error
  }

  let harness
  try {
    harness = await runCustomerServiceHarnessStep({
      event,
      memory: snapshot,
      registry: createDefaultToolRegistry(repos.knowledge),
      sessionStatus: session.status,
      sdkRunner: llm.sdkRunner,
    })
  } catch (error) {
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
  appendTurnContinuity(repos.memory, {
    customerId: input.customerId,
    productId: input.productId ?? 'general',
    conversationId,
    question: input.question,
    reply: result.reply,
  })

  return {
    reply: result.reply ?? '',
    traceId,
    sessionId: session.id,
    status: result.nextStatus,
    terminality: result.terminality,
    harnessTrace,
  }
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
