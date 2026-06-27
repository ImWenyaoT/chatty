import { NextResponse } from 'next/server'
import { isPlaygroundAuthorized, legacyChatInputSchema } from '@rental/shared'
import { createChatCompletionsAdapterFromEnv } from '@rental/llm'
import {
  createLoopRunner,
  createDefaultToolRegistry,
  deriveFailureCase,
  normalizeEvalHistory,
  shouldCreateFailureCase,
} from '@rental/agent-core'
import { getRepos, newId } from '@/lib/db'
import {
  isLegacyAvailable,
  loadLegacyEvaluator,
  loadLegacyRagService,
} from '@/lib/legacy-adapter'

// Playground endpoint: drives one bounded Chatty step end to end.
// Request:  POST { customerId, productId?, conversationId?, question, imageUrl? }
// Response: { reply, traceId, status, sessionId }
//
// Implements the docs §4 sequence: load/create session -> build memory snapshot
// -> runStep -> persist trace + update session -> return. Runs a single bounded
// step per request (docs tech-stack §2: no long loops in the handler).
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(request: Request) {
  // Optional shared-key gate: open when CHATTY_API_KEY is unset (zero-config dev),
  // enforced when a deployed instance sets it. Not per-customer identity (see
  // isPlaygroundAuthorized docs) — that needs a session/identity layer.
  if (!isPlaygroundAuthorized(request.headers.get('x-api-key'), process.env.CHATTY_API_KEY)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = legacyChatInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', issues: parsed.error.issues },
      { status: 400 },
    )
  }
  const input = parsed.data

  const { sessions, traces, reviews, failures, memory, sqliteEnabled } = getRepos()
  const conversationId =
    input.conversationId ?? `${input.customerId}:${input.productId ?? 'general'}`

  // 1. Load or create the agent session for this conversation.
  let session = sessions.findByConversation(conversationId)
  if (!session) {
    session = sessions.create({
      id: newId('sess'),
      customerId: input.customerId,
      conversationId,
      productId: input.productId,
    })
  }

  const traceId = newId('tr')
  const occurredAt = new Date().toISOString()

  // 2. Build the ConversationEvent the loop consumes.
  const payload: Record<string, unknown> = { question: input.question }
  if (input.imageUrl) payload.imageUrl = input.imageUrl
  const event = {
    eventId: newId('evt'),
    type: 'user_message' as const,
    customerId: input.customerId,
    conversationId,
    productId: input.productId,
    source: 'customer' as const,
    payload: payload as Record<string, import('@rental/shared').JsonValue>,
    occurredAt,
    traceId,
  }

  // 3. Lazy memory snapshot (JSON fallback reads the legacy store until SQLite
  //    is populated). The loop decides whether to consult RAG (lazy, PRD §9).
  const snapshot = memory.snapshot({
    customerId: input.customerId,
    conversationId,
    productId: input.productId,
  })

  // 4. Build the loop runner. Legacy path is wired only if rag-service is
  //    importable; otherwise the LLM-only fallback is used.
  const llm = createChatCompletionsAdapterFromEnv()
  let legacy
  let evaluator
  if (await isLegacyAvailable()) {
    legacy = await loadLegacyRagService()
    evaluator = await loadLegacyEvaluator()
  }
  // Phase 4 (feature-flagged): wire the Agents SDK runner when
  // CHATTY_AGENTS_SDK=1, targeting a dedicated OpenAI endpoint if configured.
  let agentsSdkRunner
  if (process.env.CHATTY_AGENTS_SDK === '1') {
    const { readAgentsSdkEnv, createAgentsSdkRunner } = await import('@rental/llm')
    const sdkEnv = readAgentsSdkEnv()
    agentsSdkRunner = createAgentsSdkRunner({ model: sdkEnv.model })
  }
  const runner = createLoopRunner({
    llm,
    legacy,
    tools: createDefaultToolRegistry(),
    agentsSdkRunner,
  })

  // 5. Run one bounded step.
  const result = await runner.runStep({
    event,
    sessionStatus: session.status,
    memory: {
      customerId: input.customerId,
      conversationId,
      productId: input.productId,
      customerMemory: snapshot.customerMemory,
      productMemory: snapshot.productMemory,
      recentMessages: snapshot.recentMessages,
    },
  })

  // 6. Persist trace + update session status. One trace row per user turn.
  traces.append({
    id: traceId,
    sessionId: session.id,
    eventType: 'agent_reply_sent',
    action: result.terminality,
    input: { question: input.question },
    output: result.reply ? { reply: result.reply } : undefined,
    toolCalls: result.toolCalls,
  })
  sessions.update(session.id, {
    status: result.nextStatus,
    currentStep: result.terminality,
    productId: input.productId,
  })

  // 6b. Conservative continuity write (docs §6.3): append this turn's messages
  //     to the conversation's recentMessages so the NEXT snapshot has prior
  //     context — closing the amnesia where the loop read memory but never wrote
  //     it. Only the message log is persisted; customer profile fields and
  //     transient RAG evidence are NOT promoted (chatty-memory-trace-migration).
  //     Gated on SQLite like eval: in JSON-only mode the legacy store stays
  //     authoritative and writing to an ephemeral in-memory db is pointless.
  if (sqliteEnabled) {
    const turn: import('@rental/shared').JsonValue[] = [{ role: 'user', content: input.question }]
    if (result.reply) turn.push({ role: 'assistant', content: result.reply })
    memory.appendRecentMessages(
      { customerId: input.customerId, productId: input.productId ?? 'general', conversationId },
      turn,
    )
  }

  // 7. Async eval (PRD §10/§13). Fire-and-forget: score the reply, persist a
  //    trace_review, and create a failure_case when below threshold. Only runs
  //    when the evaluator and SQLite persistence are available. Never blocks or
  //    fails the request — eval errors are swallowed and logged.
  if (evaluator && result.reply && sqliteEnabled) {
    void evaluateAndRecord(evaluator, {
      history: normalizeEvalHistory(snapshot.recentMessages),
      reply: result.reply,
      traceId,
      sessionId: session.id,
      traces,
      reviews,
      failures,
    }).catch((err) => {
      console.error('[chatty] async eval failed', err)
    })
  }

  return NextResponse.json({
    reply: result.reply ?? '',
    traceId,
    sessionId: session.id,
    status: result.nextStatus,
    terminality: result.terminality,
  })
}

/**
 * Scores a reply via the legacy evaluator, persists a trace_review, and — when
 * the score is below the failure threshold — creates a failure_case candidate
 * (PRD §13). Runs detached from the request so it never blocks the user turn.
 */
async function evaluateAndRecord(
  evaluator: import('@rental/agent-core').Evaluator,
  args: {
    history: Array<{ role: string; content: string }>
    reply: string
    traceId: string
    sessionId: string
    traces: import('@rental/db').TraceRepository
    reviews: import('@rental/db').TraceReviewRepository
    failures: import('@rental/db').FailureCaseRepository
  },
): Promise<void> {
  const { history, reply, traceId, sessionId, traces, reviews, failures } = args
  const result = await evaluator.evaluate(history, reply)
  reviews.append({
    id: newId('rev'),
    traceId,
    score: result.score,
    issues: result.issues,
    suggestions: result.suggestions,
    suggestedReply: result.suggestedReply,
    evaluatorModel: result.evaluatorModel,
    promptVersion: result.promptVersion,
  })

  if (shouldCreateFailureCase(result.score)) {
    const trace = traces.queryBySession(sessionId).find((t) => t.id === traceId)
    if (trace) {
      const candidate = deriveFailureCase(trace, result)
      failures.create({
        id: newId('fc'),
        traceId: candidate.traceId,
        sessionId: candidate.sessionId,
        score: candidate.score,
        issues: candidate.issues,
        input: candidate.input,
        output: candidate.output,
      })
    }
  }
}
