import type { DurableTask, DurableTaskRepository } from "@rental/db";

export interface DispatchDueDurableTaskOptions {
  tasks: DurableTaskRepository;
  now: string;
  deliver(task: DurableTask): Promise<{ receiptId: string }>;
}

/** Delivers at most one due follow-up; completed tasks are never selected again. */
export async function dispatchDueDurableTask(
  options: DispatchDueDurableTaskOptions,
): Promise<boolean> {
  const due = options.tasks.listDue(options.now)[0];
  if (!due) return false;
  const running = options.tasks.resume(due.id, "time");
  try {
    const receipt = await options.deliver(running);
    options.tasks.complete(running.id, {
      kind: "tool_receipt",
      toolName: "deliver_followup",
      receiptId: receipt.receiptId,
    });
  } catch (error) {
    options.tasks.wait(running.id, "time", {
      dueAt: due.dueAt,
      context: due.context,
    });
    throw error;
  }
  return true;
}
