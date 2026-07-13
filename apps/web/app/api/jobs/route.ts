import { NextResponse } from "next/server";
import { isPlaygroundAuthorized } from "@rental/shared";
import { getRepos } from "@/lib/db";
import { buildOperationsControlView } from "@/lib/control-plane-read-model";

/** Lists durable background jobs and outbox messages for the operations GUI. */
export async function GET(request: Request) {
  if (
    !isPlaygroundAuthorized(
      request.headers.get("x-api-key"),
      process.env.CHATTY_API_KEY,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { control } = getRepos();
  return NextResponse.json(buildOperationsControlView(control));
}

/** Cancels or retries one durable background job through an explicit state transition. */
export async function POST(request: Request) {
  if (
    !isPlaygroundAuthorized(
      request.headers.get("x-api-key"),
      process.env.CHATTY_API_KEY,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { jobId?: string; action?: string };
  try {
    body = (await request.json()) as { jobId?: string; action?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.jobId || !["cancel", "retry"].includes(body.action ?? "")) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { control } = getRepos();
  if (!control.getJob(body.jobId))
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  const changed =
    body.action === "cancel"
      ? control.cancelJob(body.jobId)
      : control.retryJob(body.jobId);
  if (!changed)
    return NextResponse.json(
      { error: "invalid_state_transition" },
      { status: 409 },
    );
  return NextResponse.json({ job: control.getJob(body.jobId) });
}
