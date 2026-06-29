import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLlmEnv, readAgentsSdkEnv } from './client-from-env.js'

test('readLlmEnv defaults chatModel to mimo-2.5', () => {
  const env = readLlmEnv({})
  assert.equal(env.chatModel, 'mimo-2.5')
  assert.equal(env.apiKey, '')
  assert.equal(env.baseURL, undefined)
})

test('readLlmEnv reads MIMO_* before OPENAI_* compatibility values', () => {
  const env = readLlmEnv({
    MIMO_API_KEY: 'mimo-1',
    MIMO_BASE_URL: 'https://api.mimo.example/v1',
    MIMO_MODEL: 'mimo-2.5',
    OPENAI_API_KEY: 'sk-1',
    OPENAI_BASE_URL: 'https://api.openai.example/v1',
  })
  assert.equal(env.apiKey, 'mimo-1')
  assert.equal(env.baseURL, 'https://api.mimo.example/v1')
  assert.equal(env.chatModel, 'mimo-2.5')
})

test('readAgentsSdkEnv falls back to shared LLM env when OPENAI_AGENTS_* unset', () => {
  const env = readAgentsSdkEnv({
    MIMO_API_KEY: 'sk-shared',
    MIMO_BASE_URL: 'https://api.mimo.example/v1',
    MIMO_MODEL: 'mimo-2.5',
  })
  assert.equal(env.apiKey, 'sk-shared')
  assert.equal(env.baseURL, 'https://api.mimo.example/v1')
  assert.equal(env.model, 'mimo-2.5')
})

test('readAgentsSdkEnv honours dedicated OPENAI_AGENTS_* for the SDK lane', () => {
  const env = readAgentsSdkEnv({
    OPENAI_API_KEY: 'sk-shared',
    OPENAI_BASE_URL: 'https://api.openai.example/v1',
    MIMO_MODEL: 'mimo-2.5',
    OPENAI_AGENTS_API_KEY: 'sk-openai',
    OPENAI_AGENTS_BASE_URL: 'https://api.openai.com/v1',
    AGENTS_SDK_MODEL: 'gpt-5-mini',
  })
  assert.equal(env.apiKey, 'sk-openai')
  assert.equal(env.baseURL, 'https://api.openai.com/v1')
  assert.equal(env.model, 'gpt-5-mini')
})
