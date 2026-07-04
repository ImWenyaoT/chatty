import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLlmEnv } from './client-from-env.js'

test('readLlmEnv defaults chatModel to deepseek-v4-pro (pinned pro tier, not the flash alias)', () => {
  const env = readLlmEnv({})
  assert.equal(env.chatModel, 'deepseek-v4-pro')
  assert.equal(env.apiKey, '')
  assert.equal(env.baseURL, undefined)
})

test('readLlmEnv reads OPENAI_* and CHAT_MODEL', () => {
  const env = readLlmEnv({
    OPENAI_API_KEY: 'sk-1',
    OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    CHAT_MODEL: 'deepseek-reasoner',
  })
  assert.equal(env.apiKey, 'sk-1')
  assert.equal(env.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(env.chatModel, 'deepseek-reasoner')
})
