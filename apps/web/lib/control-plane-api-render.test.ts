import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DashboardPage from "../app/dashboard/page";
import { GET as getPlaygroundHistory } from "../app/api/playground/route";
import {
  GET as getControlPlane,
  POST as postControlPlane,
} from "../app/api/control-plane/route";
import { GET as getJobs, POST as postJobs } from "../app/api/jobs/route";
import { POST as postTraceReview } from "../app/api/trace-reviews/route";
import { POST as postOrder } from "../app/api/orders/place/route";
import { getRepos } from "./db";

test("playground history API restores a persisted conversation transcript", async () => {
  const repos = getRepos();
  repos.sessions.create({
    id: "session-history-api",
    customerId: "customer-history-api",
    conversationId: "conversation-history-api",
  });
  repos.traces.append({
    id: "trace-history-api",
    sessionId: "session-history-api",
    eventType: "agent_reply_sent",
    input: { question: "租期怎么算？" },
    output: { reply: "从签收次日开始计算。" },
  });

  const response = await getPlaygroundHistory(
    new Request(
      "http://localhost/api/playground?conversationId=conversation-history-api",
    ),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    messages: Array<{ createdAt: string }>;
  };
  assert.equal(typeof body.messages[0]?.createdAt, "string");
  assert.equal(typeof body.messages[1]?.createdAt, "string");
  assert.deepEqual(body, {
    conversationId: "conversation-history-api",
    sessionId: "session-history-api",
    hasEarlierMessages: false,
    messages: [
      {
        id: "trace-history-api:user",
        role: "user",
        content: "租期怎么算？",
        createdAt: body.messages[0]?.createdAt,
      },
      {
        id: "trace-history-api:assistant",
        role: "assistant",
        content: "从签收次日开始计算。",
        traceId: "trace-history-api",
        sessionId: "session-history-api",
        createdAt: body.messages[1]?.createdAt,
      },
    ],
  });
});

test("control-plane APIs serialize explicit empty and unknown state", async () => {
  const controlResponse = await getControlPlane(
    new Request(
      "http://localhost/api/control-plane?conversationId=empty&runId=missing",
    ),
  );
  const control = await controlResponse.json();
  assert.equal(controlResponse.status, 200);
  assert.equal(control.queueDepth, 0);
  assert.equal(control.workflow.displayState, "unknown");

  const jobsResponse = await getJobs(new Request("http://localhost/api/jobs"));
  const jobs = await jobsResponse.json();
  assert.equal(jobsResponse.status, 200);
  assert.deepEqual(jobs.jobs, []);
  assert.equal(jobs.metrics.retryRate, null);
});

test("review dashboard starts from the real Trace loading state", () => {
  Object.assign(globalThis, { React });
  const markup = renderToStaticMarkup(React.createElement(DashboardPage));
  assert.match(markup, /正在读取 Trace/);
  assert.doesNotMatch(markup, /后台任务|attempt|投递记录/);
});

test("control-plane APIs expose invalid and absent transition inputs", async () => {
  const invalidControl = await postControlPlane(
    new Request("http://localhost/api/control-plane", {
      method: "POST",
      body: JSON.stringify({ action: "cancel" }),
    }),
  );
  assert.deepEqual(await invalidControl.json(), { error: "invalid_input" });

  const missingRun = await postControlPlane(
    new Request("http://localhost/api/control-plane", {
      method: "POST",
      body: JSON.stringify({ runId: "run-missing", action: "cancel" }),
    }),
  );
  assert.equal(missingRun.status, 404);
  assert.deepEqual(await missingRun.json(), { error: "not_found" });

  const invalidJob = await postJobs(
    new Request("http://localhost/api/jobs", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-missing", action: "unknown" }),
    }),
  );
  assert.deepEqual(await invalidJob.json(), { error: "invalid_input" });
});

test("trace review API rejects malformed request JSON explicitly", async () => {
  const response = await postTraceReview(
    new Request("http://localhost/api/trace-reviews", {
      method: "POST",
      body: "{",
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("order API persists the submitted order through the HTTP to SQLite seam", async () => {
  const response = await postOrder(
    new Request("http://localhost/api/orders/place", {
      method: "POST",
      body: JSON.stringify({
        customerId: "integration-customer",
        productId: "SUIT-001",
        conversationId: "integration-conversation",
        orderNo: "ORDER-INTEGRATION-001",
      }),
    }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    memory: { conversationProfile: { orderPlacement: { orderNo: string } } };
  };
  assert.equal(body.ok, true);
  assert.equal(
    body.memory.conversationProfile.orderPlacement.orderNo,
    "ORDER-INTEGRATION-001",
  );
  const persisted = getRepos().memory.snapshot({
    customerId: "integration-customer",
    productId: "SUIT-001",
    conversationId: "integration-conversation",
  });
  const profile = persisted.conversationProfile as {
    orderPlacement: { orderNo: string };
  };
  assert.equal(profile.orderPlacement.orderNo, "ORDER-INTEGRATION-001");
});
