import { NextResponse } from 'next/server'
import { legacyChatInputSchema } from '@rental/shared'
import { createChatCompletionsAdapterFromEnv } from '@rental/llm'
import { createLoopRunner, createDefaultToolRegistry } from '@rental/agent-core'
import { getRepos, newId } from '@/lib/db'
import { isLegacyAvailable, loadLegacyRagService } from '@/lib/legacy-adapter'

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

  const { sessions, traces, memory } = getRepos()
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
  if (await isLegacyAvailable()) {
    legacy = await loadLegacyRagService()
  }
  const runner = createLoopRunner({
    llm,
    legacy,
    tools: createDefaultToolRegistry(),
  })

  // 5. Run one bounded step.
  const result = await runner.runStep({
    event,
    memory: {
      customerId: input.customerId,
      conversationId,
      productId: input.productId,
      customerMemory: snapshot.customerMemory,
      productMemory: snapshot.productMemory,
      recentMessages: snapshot.recentMessages,
    },
    tools: [],
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

  return NextResponse.json({
    reply: result.reply ?? '',
    traceId,
    sessionId: session.id,
    status: result.nextStatus,
    terminality: result.terminality,
  })
}
