import { NextResponse } from "next/server";
import { isPlaygroundAuthorized } from "@rental/shared";
import { getRepos } from "@/lib/db";
import { HarnessRunController } from "@/lib/harness-run-controller";
import { buildConversationControlView } from "@/lib/control-plane-read-model";
import { InvalidWorkflowTransitionError } from "@rental/db";

/** Returns workflow, checkpoint, and long-term memory evidence for observability panels. */
export async function GET(request: Request) {
  if (
    !isPlaygroundAuthorized(
      request.headers.get("x-api-key"),
      process.env.CHATTY_API_KEY,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId") ?? "";
  const customerId = url.searchParams.get("customerId") ?? "";
  const runId = url.searchParams.get("runId") ?? "";
  const { control, memory } = getRepos();
  return NextResponse.json({
    ...buildConversationControlView(control, { conversationId, runId }),
    checkpoint: conversationId
      ? control.latestCheckpoint(conversationId)
      : undefined,
    memories: customerId ? control.listMemoryCandidates(customerId) : [],
    memory:
      customerId && conversationId
        ? memory.snapshot({ customerId, conversationId })
        : undefined,
  });
}

/** Cancels one active Harness run and propagates AbortSignal to the SDK runner. */
export async function POST(request: Request) {
  if (
    !isPlaygroundAuthorized(
      request.headers.get("x-api-key"),
      process.env.CHATTY_API_KEY,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { runId?: string; action?: string };
  try {
    body = (await request.json()) as { runId?: string; action?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.runId || body.action !== "cancel") {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { control } = getRepos();
  if (!control.getRun(body.runId))
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    return NextResponse.json({
      run: new HarnessRunController(control).cancel(body.runId),
    });
  } catch (error) {
    if (error instanceof InvalidWorkflowTransitionError) {
      return NextResponse.json(
        { error: "invalid_state_transition" },
        { status: 409 },
      );
    }
    throw error;
  }
}
