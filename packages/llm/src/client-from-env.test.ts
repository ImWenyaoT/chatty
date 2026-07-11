import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLlmEnv } from './client-from-env.js'

test('readLlmEnv defaults chatModel to deepseek-v4-pro (pinned pro tier, not the flash alias)', () => {
  const env = readLlmEnv({})
  assert.equal(env.chatModel, 'deepseek-v4-pro')
  assert.equal(env.apiKey, '')
  assert.equal(env.baseURL, 'https://api.deepseek.com/beta')
})

test('readLlmEnv reads OPENAI_* and CHAT_MODEL', () => {
  const env = readLlmEnv({
    OPENAI_API_KEY: 'sk-1',
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    CHAT_MODEL: 'deepseek-v4-pro',
  })
  assert.equal(env.apiKey, 'sk-1')
  assert.equal(env.baseURL, 'https://api.deepseek.com')
  assert.equal(env.chatModel, 'deepseek-v4-pro')
})

test('readLlmEnv pins DeepSeek flash and deprecated aliases back to pro', () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner']) {
    const env = readLlmEnv({ CHAT_MODEL: model })
    assert.equal(env.chatModel, 'deepseek-v4-pro')
  }
})
