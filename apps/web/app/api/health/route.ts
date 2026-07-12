import { NextResponse } from "next/server";

// Lightweight liveness probe. Kept dependency-free so it stays cheap even when
// the agent loop / SQLite path is not yet wired.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "chatty-web",
    time: new Date().toISOString(),
  });
}
