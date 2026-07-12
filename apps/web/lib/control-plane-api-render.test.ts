import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DashboardPage from "../app/dashboard/page";
import {
  GET as getControlPlane,
  POST as postControlPlane,
} from "../app/api/control-plane/route";
import { GET as getJobs, POST as postJobs } from "../app/api/jobs/route";
import { POST as postTraceReview } from "../app/api/trace-reviews/route";

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

test("review dashboard renders explicit empty operational evidence", () => {
  Object.assign(globalThis, { React });
  const markup = renderToStaticMarkup(React.createElement(DashboardPage));
  assert.match(markup, /暂无后台任务/);
  assert.match(markup, /未知（无 attempt）/);
  assert.match(markup, /暂无投递记录/);
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
