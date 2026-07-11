import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DashboardPage from '../app/dashboard/page'
import { GET as getControlPlane } from '../app/api/control-plane/route'
import { GET as getJobs } from '../app/api/jobs/route'

test('control-plane APIs serialize explicit empty and unknown state', async () => {
  const controlResponse = await getControlPlane(
    new Request('http://localhost/api/control-plane?conversationId=empty&runId=missing'),
  )
  const control = await controlResponse.json()
  assert.equal(controlResponse.status, 200)
  assert.equal(control.queueDepth, 0)
  assert.equal(control.workflow.displayState, 'unknown')

  const jobsResponse = await getJobs(new Request('http://localhost/api/jobs'))
  const jobs = await jobsResponse.json()
  assert.equal(jobsResponse.status, 200)
  assert.deepEqual(jobs.jobs, [])
  assert.equal(jobs.metrics.retryRate, null)
})

test('review dashboard renders explicit empty operational evidence', () => {
  Object.assign(globalThis, { React })
  const markup = renderToStaticMarkup(React.createElement(DashboardPage))
  assert.match(markup, /暂无后台任务/)
  assert.match(markup, /未知（无 attempt）/)
  assert.match(markup, /暂无投递记录/)
})
