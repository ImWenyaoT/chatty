import { NextResponse } from 'next/server'
import { isPlaygroundAuthorized, legacyChatInputSchema } from '@rental/shared'
import {
  createDefaultToolRegistry,
  normalizeEvalHistory,
  runCustomerServiceHarnessStep,
} from '@rental/agent-core'
import { getRepos, newId } from '@/lib/db'
import { scheduleTraceEvaluation } from '@/lib/eval-chain'
import { createPlaygroundModelFn } from '@/lib/llm'

// Playground endpoint: drives one bounded customer-service Harness step end to end.
// Request:  POST { customerId, productId?, conversationId?, question, imageUrl? }
// Response: { reply, traceId, status, sessionId, harnessTrace }
//
// Implements the docs §4 sequence: load/create session -> build memory snapshot
// -> schedule/build context/parse/execute -> persist trace + update session -> return.
// Runs a single bounded step per request (docs tech-stack §2: no long loops in the handler).
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

  const { sessions, traces, reviews, failures, memory } = getRepos()
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
  //    is populated). The harness context builder turns this into inspectable fragments.
  const snapshot = memory.snapshot({
    customerId: input.customerId,
    conversationId,
    productId: input.productId,
  })

  // 4. Run one bounded customer-service Harness step. Compose is LLM-backed
  // when CHATTY_LLM=1 and an API key is configured (Chat Completions adapter);
  // otherwise — and on any model failure — the deterministic composer answers,
  // so scheduler/context/executor/trace contracts never depend on a provider.
  // The snapshot record is a structural superset of the harness MemorySnapshot.
  const harness = await runCustomerServiceHarnessStep({
    event,
    memory: snapshot,
    registry: createDefaultToolRegistry(),
    sessionStatus: session.status,
    modelFn: createPlaygroundModelFn(),
  })
  const result = harness.step

  // 5. Persist trace + update session status. One trace row per user turn.
  const trace = traces.append({
    id: traceId,
    sessionId: session.id,
    eventType: 'agent_reply_sent',
    intent: harness.trace.task.kind,
    action: harness.trace.action.action,
    input: {
      question: input.question,
      harnessContext: harness.trace.context
        .fragments as unknown as import('@rental/shared').JsonValue,
    },
    // handoff 原因等 memoryPatch 随 trace 落库，人工接手时从 trace 可读（PRD §15）
    output:
      result.reply || result.memoryPatch
        ? {
            ...(result.reply ? { reply: result.reply } : {}),
            ...(result.memoryPatch !== undefined ? { memoryPatch: result.memoryPatch } : {}),
            harnessTrace: harness.trace as unknown as import('@rental/shared').JsonValue,
          }
        : undefined,
    toolCalls: result.toolCalls,
    references: harness.trace.context.fragments as unknown as import('@rental/shared').JsonValue[],
  })
  sessions.update(session.id, {
    status: result.nextStatus,
    currentStep: result.terminality,
    productId: input.productId,
  })

  // 5b. Conservative continuity write (docs §6.3): append this turn's messages
  //     to the conversation's recentMessages so the NEXT snapshot has prior
  //     context — closing the amnesia where the loop read memory but never wrote
  //     it. Only the message log is persisted; customer profile fields and
  //     transient RAG evidence are NOT promoted (chatty-memory-trace-migration).
  {
    const turn: import('@rental/shared').JsonValue[] = [{ role: 'user', content: input.question }]
    if (result.reply) turn.push({ role: 'assistant', content: result.reply })
    memory.appendRecentMessages(
      { customerId: input.customerId, productId: input.productId ?? 'general', conversationId },
      turn,
    )
  }

  // 5c. Eval flywheel, first half (PRD §10/§13): fire-and-forget LLM-judge on
  //     the persisted trace — review lands in trace_reviews, low scores promote
  //     a failure_case (lib/eval-chain, which also backfills a couple of
  //     unevaluated traces). Never blocks the response; without OPENAI_API_KEY
  //     it silently no-ops.
  if (result.reply) {
    scheduleTraceEvaluation(
      { traces, reviews, failures },
      {
        trace,
        history: [
          ...normalizeEvalHistory(snapshot.recentMessages),
          { role: 'user', content: input.question },
        ],
        reply: result.reply,
      },
    )
  }

  return NextResponse.json({
    reply: result.reply ?? '',
    traceId,
    sessionId: session.id,
    status: result.nextStatus,
    terminality: result.terminality,
    harnessTrace: harness.trace,
  })
}
