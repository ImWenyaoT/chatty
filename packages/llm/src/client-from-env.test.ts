import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLlmEnv, readAgentsSdkEnv } from './client-from-env.js'

test('readLlmEnv defaults chatModel to deepseek-chat (unified with .env.example)', () => {
  const env = readLlmEnv({})
  assert.equal(env.chatModel, 'deepseek-chat')
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

test('readAgentsSdkEnv falls back to shared LLM env when OPENAI_AGENTS_* unset', () => {
  const env = readAgentsSdkEnv({
    OPENAI_API_KEY: 'sk-shared',
    OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    CHAT_MODEL: 'deepseek-chat',
  })
  // Dual-provider fallback: SDK lane inherits the cheaper shared endpoint.
  assert.equal(env.apiKey, 'sk-shared')
  assert.equal(env.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(env.model, 'deepseek-chat')
})

test('readAgentsSdkEnv honours dedicated OPENAI_AGENTS_* for the SDK lane', () => {
  const env = readAgentsSdkEnv({
    OPENAI_API_KEY: 'sk-shared',
    OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    CHAT_MODEL: 'deepseek-chat',
    OPENAI_AGENTS_API_KEY: 'sk-openai',
    OPENAI_AGENTS_BASE_URL: 'https://api.openai.com/v1',
    AGENTS_SDK_MODEL: 'gpt-4o-mini',
  })
  assert.equal(env.apiKey, 'sk-openai')
  assert.equal(env.baseURL, 'https://api.openai.com/v1')
  assert.equal(env.model, 'gpt-4o-mini')
})
