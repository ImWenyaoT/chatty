import { NextResponse } from "next/server";
import { isPlaygroundAuthorized, legacyChatInputSchema } from "@rental/shared";
import {
  ConversationBusyError,
  InvalidWorkflowTransitionError,
} from "@rental/db";
import {
  CustomerServiceProviderError,
  runCustomerServiceTurn,
} from "@/lib/customer-service-turn";
import { MissingLlmApiKeyError } from "@/lib/llm";
import { getRepos } from "@/lib/db";
import { readConversationHistory } from "@/lib/conversation-history";

// Customer-service endpoint: drives one bounded seller-assistant Harness step.
// Request:  POST { customerId, productId?, conversationId?, question, imageUrl? }
// Response: { reply, traceId, status, sessionId, harnessTrace }
//
// Implements the docs §4 sequence: load/create session -> build memory snapshot
// -> schedule/build context/parse/execute -> persist trace + update session -> return.
// Runs a single bounded step per request (docs tech-stack §2: no long loops in the handler).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Returns the persisted seller transcript for one conversation. */
export async function GET(request: Request) {
  if (
    !isPlaygroundAuthorized(
      request.headers.get("x-api-key"),
      process.env.CHATTY_API_KEY,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const conversationId = new URL(request.url).searchParams.get(
    "conversationId",
  );
  if (!conversationId?.trim()) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  return NextResponse.json(
    readConversationHistory(getRepos(), conversationId.trim()),
  );
}

export async function POST(request: Request) {
  // Optional shared-key gate: open when CHATTY_API_KEY is unset (zero-config dev),
  // enforced when a deployed instance sets it. Not per-customer identity (see
  // isPlaygroundAuthorized docs) — that needs a session/identity layer.
  if (
    !isPlaygroundAuthorized(
      request.headers.get("x-api-key"),
      process.env.CHATTY_API_KEY,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = legacyChatInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  try {
    return NextResponse.json(await runCustomerServiceTurn(input));
  } catch (error) {
    if (error instanceof MissingLlmApiKeyError) {
      return NextResponse.json(
        { error: "llm_not_configured" },
        { status: 503 },
      );
    }
    if (error instanceof CustomerServiceProviderError) {
      return NextResponse.json(
        { error: "llm_provider_failed" },
        { status: 502 },
      );
    }
    if (
      error instanceof ConversationBusyError ||
      error instanceof InvalidWorkflowTransitionError
    ) {
      return NextResponse.json({ error: "workflow_conflict" }, { status: 409 });
    }
    throw error;
  }
}
