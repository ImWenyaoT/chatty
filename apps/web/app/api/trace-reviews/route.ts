import { NextResponse } from "next/server";
import { isPlaygroundAuthorized, traceReviewInputSchema } from "@rental/shared";
import { getRepos } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Returns aggregate human trace review metrics for the seller dashboard. */
export async function GET(request: Request) {
  if (
    !isPlaygroundAuthorized(
      request.headers.get("x-api-key"),
      process.env.CHATTY_API_KEY,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { reviews } = getRepos();
  return NextResponse.json({ summary: reviews.summarize() });
}

/** Records or updates one human review for a trace. */
export async function POST(request: Request) {
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

  const parsed = traceReviewInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { reviews } = getRepos();
  const review = reviews.upsert(parsed.data);
  return NextResponse.json({ review, summary: reviews.summarize() });
}
