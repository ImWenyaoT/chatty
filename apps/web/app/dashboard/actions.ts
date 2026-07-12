"use server";

import { getRepos } from "@/lib/db";

export type JobActionResult =
  { ok: true } | { ok: false; error: "not_found" | "invalid_state_transition" };

export async function updateBackgroundJob(
  jobId: string,
  action: "cancel" | "retry",
): Promise<JobActionResult> {
  const { control } = getRepos();
  if (!control.getJob(jobId)) return { ok: false, error: "not_found" };
  const changed =
    action === "cancel" ? control.cancelJob(jobId) : control.retryJob(jobId);
  return changed
    ? { ok: true }
    : { ok: false, error: "invalid_state_transition" };
}
