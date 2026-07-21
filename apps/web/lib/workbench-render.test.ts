import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import React from 'react'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/workbench',
})

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  self: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  MutationObserver: {
    configurable: true,
    value: dom.window.MutationObserver,
  },
  React: { configurable: true, value: React },
  IS_REACT_ACT_ENVIRONMENT: {
    configurable: true,
    value: true,
    writable: true,
  },
})

const { cleanup, fireEvent, render, screen } =
  await import('@testing-library/react')
const { default: WorkbenchPage } = await import('../src/features/WorkbenchPage')

const contentArtifact = {
  id: 'artifact-content-1',
  kind: 'content',
  owner_id: 'demo-customer',
  session_id: 'session-1',
  title: '高精地图内容包',
  status: 'review_pending',
  created_at: '2026-07-21T00:00:00.000Z',
  updated_at: '2026-07-21T00:00:00.000Z',
  research_artifact_id: 'artifact-research-1',
  channels: [
    {
      channel: 'xiaohongshu',
      title: '高精地图如何支持智能驾驶',
      body: '从定位与地图更新理解产业链。',
      claim_ids: ['claim-position'],
    },
  ],
}

test('workbench runs one Agent task, loads artifacts, and keeps approval human-owned', async () => {
  const requests: string[] = []
  let approved = false
  let releaseApproval: (() => void) | undefined
  const approvalPending = new Promise<void>((resolve) => {
    releaseApproval = resolve
  })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${url}`)
    if (method === 'POST' && url.endsWith('/runs')) {
      return Response.json({
        reply: '研究简报和内容草稿已保存，等待人工批准。',
        customer_id: 'demo-customer',
        session_id: 'session-1',
        trace_id: 'trace-1',
        request_id: 'request-1',
        status: 'completed',
        business_outcome: 'verified',
        completion_evidence: 'artifact:artifact-content-1:review_pending',
        knowledge_search_results: [],
        memory_events: [],
        needs_human: false,
        support_request_id: null,
      })
    }
    if (method === 'POST' && url.endsWith('/approve')) {
      await approvalPending
      approved = true
      return Response.json({
        id: 'approval-1',
        artifact_id: contentArtifact.id,
        actor_id: 'demo-reviewer',
        decision: 'approved',
        created_at: '2026-07-21T00:00:01.000Z',
      })
    }
    if (url.includes('/artifacts?session_id=session-1')) {
      return Response.json([
        {
          ...contentArtifact,
          status: approved ? 'approved' : 'review_pending',
        },
      ])
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }

  render(React.createElement(WorkbenchPage))
  assert.equal(
    screen.getByRole('heading', { name: 'Agent 内容工作台' }).textContent,
    'Agent 内容工作台',
  )

  fireEvent.change(screen.getByLabelText('任务描述'), {
    target: { value: '生成高精地图产业简报和小红书草稿' },
  })
  fireEvent.click(screen.getByRole('button', { name: '运行 Agent' }))
  await screen.findByText('高精地图内容包')
  assert.match(screen.getByText(/trace-1/).textContent ?? '', /trace-1/)

  fireEvent.click(screen.getByRole('button', { name: '批准内容包' }))
  assert.equal(
    screen.getByRole('button', { name: '运行 Agent' }).textContent,
    '运行 Agent',
  )
  assert.equal(
    screen.getByLabelText('任务描述').getAttribute('aria-invalid'),
    null,
  )
  assert.equal(
    screen.getByRole('region', { name: 'Artifacts' }).getAttribute('aria-busy'),
    'true',
  )
  assert.equal(
    screen.getByRole('button', { name: '批准内容包' }).textContent,
    '批准中',
  )
  releaseApproval?.()
  await screen.findByText('已批准')
  assert.deepEqual(requests, [
    'POST /api/chatty/runs',
    'GET /api/chatty/artifacts?session_id=session-1',
    'POST /api/chatty/artifacts/artifact-content-1/approve',
    'GET /api/chatty/artifacts?session_id=session-1',
  ])

  cleanup()
  dom.window.close()
})
