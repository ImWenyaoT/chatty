import { randomUUID } from "node:crypto";
import { dispatchBackgroundJob } from "../apps/web/lib/background-job-worker.ts";
import {
  recoverCustomerServiceTurns,
  runCustomerServiceTurn,
} from "../apps/web/lib/customer-service-turn.ts";
import { getRepos } from "../apps/web/lib/db.ts";
import {
  runMemoryConsolidation,
  runMemoryExtraction,
} from "../apps/web/lib/memory-pipeline.ts";

const workerId = process.env.CHATTY_WORKER_ID ?? `worker-${randomUUID()}`;
const pollMs = Number(process.env.CHATTY_JOB_POLL_MS || 1_000);
const leaseMs = Number(process.env.CHATTY_JOB_LEASE_MS || 60_000);
const heartbeatMs = Number(process.env.CHATTY_JOB_HEARTBEAT_MS || 20_000);
const once = process.argv.includes("--once");

/** Processes one leased background job through the fenced dispatch seam. */
async function processOne(): Promise<boolean> {
  const repos = getRepos();
  return dispatchBackgroundJob({
    control: repos.control,
    workerId,
    leaseMs,
    heartbeatMs,
    executors: {
      /** Executes one extraction claim with the dispatcher's shared cancellation signal. */
      async memoryExtract(job, signal) {
        const payload = asObject(job.payload);
        const result = await runMemoryExtraction({
          traces: repos.traces,
          sessionId: String(payload.sessionId ?? ""),
          customerId: job.customerId ?? "",
          conversationId: job.conversationId ?? "",
          productId: String(payload.productId ?? "general"),
          id: (prefix) => `${prefix}_${randomUUID()}`,
          signal,
        });
        if (result.candidates.length && job.customerId) {
          repos.control.scheduleMemoryConsolidation({
            id: `job_${randomUUID()}`,
            customerId: job.customerId,
            now: new Date().toISOString(),
          });
        }
        return {
          event: { produced: result.candidates.length },
          extraction: {
            customerId: job.customerId ?? "",
            conversationId: job.conversationId ?? "",
            productId: String(payload.productId ?? "general"),
            ...result,
          },
        };
      },
      /** Executes one consolidation claim with the dispatcher's shared cancellation signal. */
      async memoryConsolidate(job, signal) {
        const result = await runMemoryConsolidation({
          control: repos.control,
          customerId: job.customerId ?? "",
          signal,
        });
        return {
          event: {
            promoted: result.promotedIds.length,
            pruned: result.prunedIds.length,
          },
          consolidation: { customerId: job.customerId ?? "", ...result },
        };
      },
      /** Executes one scheduled turn and returns its delivery for atomic publication. */
      async scheduledFollowup(job, signal) {
        if (process.env.CHATTY_WORKER_FIXTURE === "scheduled-followup") {
          return {
            event: { fixture: "scheduled-followup" },
            followup: {
              runId: "integration-run",
              payload: { reply: "integration delivery" },
            },
          };
        }
        const payload = asObject(job.payload);
        const response = await runCustomerServiceTurn(
          {
            customerId: job.customerId ?? "system",
            conversationId: job.conversationId,
            question: `系统到期跟进：${String(payload.reason ?? "请继续跟进当前租赁事项")}`,
          },
          { signal },
        );
        return {
          event: { traceId: response.traceId },
          followup: {
            runId: response.runId,
            payload: { reply: response.reply },
          },
        };
      },
    },
  });
}

/** Narrows a persisted JSON payload to an object for job dispatch. */
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

let keepPolling = true;
getRepos().control.releaseInterruptedConversationEvents();
await recoverCustomerServiceTurns({ repos: getRepos() });
do {
  const processed = await processOne();
  if (once) keepPolling = false;
  if (!processed && keepPolling)
    await new Promise((resolve) => setTimeout(resolve, pollMs));
} while (keepPolling);
