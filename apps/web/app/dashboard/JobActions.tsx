"use client";

import { useState } from "react";
import { Button } from "../components/ui/button";
import { updateBackgroundJob, type JobActionResult } from "./actions";

export function jobActionMessage(
  result: JobActionResult,
  action: "cancel" | "retry",
): string {
  if (result.ok) return `${action} 已提交`;
  if (result.error === "not_found") return "任务不存在或已被清理";
  return "任务状态已变化，请刷新后重试";
}

/** Provides explicit cancel and retry controls for one durable background job. */
export function JobActions({
  jobId,
  status,
}: {
  jobId: string;
  status: string;
}) {
  const [message, setMessage] = useState("");

  /** Sends one explicit background-job transition to the control-plane API. */
  async function update(action: "cancel" | "retry") {
    try {
      setMessage(
        jobActionMessage(await updateBackgroundJob(jobId, action), action),
      );
    } catch {
      setMessage("无法连接服务，请稍后重试");
    }
  }

  return (
    <div className="dashboard-actions">
      <Button
        disabled={!["pending", "running"].includes(status)}
        onClick={() => update("cancel")}
      >
        取消
      </Button>
      <Button disabled={status !== "failed"} onClick={() => update("retry")}>
        重试
      </Button>
      <span aria-live="polite">{message}</span>
    </div>
  );
}
