import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAgentsSdkToolLoopFn,
  createDeepSeekAgentsModelFromEnv,
  toAgentsSdkFunctionTool,
} from './agents-sdk-adapter.js'

test('createAgentsSdkToolLoopFn exposes an SDK-backed tool loop adapter boundary', () => {
  assert.equal(typeof createAgentsSdkToolLoopFn, 'function')
})

test('toAgentsSdkFunctionTool converts a Chatty tool into an SDK function tool', async () => {
  const sdkTool = toAgentsSdkFunctionTool({
    name: 'search_knowledge',
    description: 'Search seller knowledge',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    needsApproval: false,
    execute: async (input) => ({ ok: true, input }),
  })

  assert.equal(sdkTool.type, 'function')
  assert.equal(sdkTool.name, 'search_knowledge')
  assert.equal(sdkTool.description, 'Search seller knowledge')
  assert.equal(sdkTool.strict, false)
  assert.equal(
    await sdkTool.invoke({} as never, '{"query":"押金"}'),
    '{"ok":true,"input":{"query":"押金"}}',
  )
})

test('createDeepSeekAgentsModelFromEnv wraps DeepSeek with SDK Chat Completions model', () => {
  const model = createDeepSeekAgentsModelFromEnv({
    OPENAI_API_KEY: 'sk-test',
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    CHAT_MODEL: 'deepseek-v4-pro',
  })

  assert.equal(model.constructor.name, 'OpenAIChatCompletionsModel')
})
