"use client";

import { useState } from "react";
import { Button } from "../components/ui/button";

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
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, action }),
    });
    setMessage(response.ok ? `${action} 已提交` : `${action} 失败`);
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
