import { NextResponse } from 'next/server'
import { isPlaygroundAuthorized, legacyChatInputSchema } from '@rental/shared'
import { runCustomerServiceTurn } from '@/lib/customer-service-turn'

// Customer-service endpoint: drives one bounded seller-assistant Harness step.
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

  return NextResponse.json(await runCustomerServiceTurn(input))
}
