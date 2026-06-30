import assert from 'node:assert/strict'
import test from 'node:test'
import { createResponsesAdapter } from './responses-adapter.js'

test('complete sends chat-like messages through the Responses API', async () => {
  const calls: unknown[] = []
  const client = {
    responses: {
      create: async (payload: unknown) => {
        calls.push(payload)
        return { output_text: '  已收到  ' }
      },
    },
  }

  const adapter = createResponsesAdapter({
    client,
    model: 'mimo-2.5',
  })

  const text = await adapter.complete([
    { role: 'system', content: '你是客服助手' },
    { role: 'user', content: '有黑色西装吗？' },
  ])

  assert.equal(text, '已收到')
  assert.deepEqual(calls, [
    {
      model: 'mimo-2.5',
      input: [
        { role: 'system', content: '你是客服助手' },
        { role: 'user', content: '有黑色西装吗？' },
      ],
    },
  ])
})
