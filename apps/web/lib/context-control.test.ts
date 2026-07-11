import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createControlPlaneRepository, openDatabase } from '@rental/db'
import type { MemorySnapshot } from '@rental/shared'
import { compactContextIfNeeded, estimateContextTokens, projectContext } from './context-control'

/** Builds a snapshot large enough to force deterministic compaction. */
function largeSnapshot(): MemorySnapshot {
  return {
    customerId: 'customer-1',
    conversationId: 'conversation-1',
    recentMessages: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `message-${index}-${'x'.repeat(40)}`,
    })),
    customerMemory: { summary: 'transaction summary' },
  }
}

/** Returns one deterministic checkpoint summary for compaction tests. */
async function checkpointSummary() {
  return {
    currentGoal: 'finish rental',
    confirmedFacts: ['size L'],
    decisions: [],
    preferences: [],
    workflowState: 'answering',
    unresolved: ['delivery date'],
    references: ['trace-2'],
  }
}

test('compaction persists the included trace boundary and actual projected token count', async () => {
  const control = createControlPlaneRepository(openDatabase(':memory:'))
  const snapshot = largeSnapshot()
  const memories = [
    {
      id: 'memory-1',
      customerId: 'customer-1',
      conversationId: 'conversation-1',
      sourceTraceId: 'trace-1',
      category: 'measurement',
      key: 'suit_size',
      value: 'L',
      confidence: 1,
      sensitivity: 'normal',
      status: 'promoted' as const,
      usageCount: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    },
  ]
  const result = await compactContextIfNeeded({
    control,
    snapshot,
    conversationId: 'conversation-1',
    throughTraceId: 'trace-2',
    checkpointId: 'checkpoint-1',
    workflowState: 'answering',
    tokenLimit: 1,
    memories,
    generateCheckpoint: checkpointSummary,
  })

  assert.equal(result.checkpoint?.throughTraceId, 'trace-2')
  const projected = projectContext({ snapshot, checkpoint: result.checkpoint, memories })
  assert.equal(result.checkpoint?.tokenAfter, estimateContextTokens(projected))
  assert.deepEqual(
    projected.recentMessages.map((message) => (message as { content: string }).content.slice(0, 9)),
    ['message-2', 'message-3', 'message-4', 'message-5', 'message-6', 'message-7'],
  )
  assert.deepEqual((projected.customerMemory as { longTerm: unknown[] }).longTerm, [
    { id: 'memory-1', category: 'measurement', key: 'suit_size', value: 'L' },
  ])
})

test('compaction preserves the previous checkpoint when generation or save fails', async () => {
  const control = createControlPlaneRepository(openDatabase(':memory:'))
  const previous = control.saveCheckpoint({
    id: 'checkpoint-old',
    conversationId: 'conversation-1',
    throughTraceId: 'trace-1',
    summary: { currentGoal: 'old goal' },
    tokenBefore: 100,
    tokenAfter: 20,
    model: 'deepseek-v4-pro',
  })

  const result = await compactContextIfNeeded({
    control,
    snapshot: largeSnapshot(),
    conversationId: 'conversation-1',
    throughTraceId: 'trace-2',
    checkpointId: 'checkpoint-new',
    workflowState: 'answering',
    tokenLimit: 1,
    generateCheckpoint: async () => {
      throw new Error('provider unavailable')
    },
  })

  assert.equal(result.failureKind, 'generation_or_save_failed')
  assert.deepEqual(control.latestCheckpoint('conversation-1'), previous)
})

test('compaction preserves the previous checkpoint when persistence rejects the replacement', async () => {
  const control = createControlPlaneRepository(openDatabase(':memory:'))
  const previous = control.saveCheckpoint({
    id: 'checkpoint-old',
    conversationId: 'conversation-1',
    throughTraceId: 'trace-1',
    summary: { currentGoal: 'old goal' },
    tokenBefore: 100,
    tokenAfter: 20,
    model: 'deepseek-v4-pro',
  })
  const rejectingControl = {
    ...control,
    /** Simulates an atomic checkpoint persistence failure. */
    saveCheckpoint() {
      throw new Error('disk unavailable')
    },
  }

  const result = await compactContextIfNeeded({
    control: rejectingControl,
    snapshot: largeSnapshot(),
    conversationId: 'conversation-1',
    throughTraceId: 'trace-2',
    checkpointId: 'checkpoint-new',
    workflowState: 'answering',
    tokenLimit: 1,
    generateCheckpoint: checkpointSummary,
  })

  assert.equal(result.failureKind, 'generation_or_save_failed')
  assert.deepEqual(control.latestCheckpoint('conversation-1'), previous)
})

test('compaction refuses to invent a replay boundary before any trace exists', async () => {
  const control = createControlPlaneRepository(openDatabase(':memory:'))
  const result = await compactContextIfNeeded({
    control,
    snapshot: largeSnapshot(),
    conversationId: 'conversation-1',
    checkpointId: 'checkpoint-1',
    workflowState: 'answering',
    tokenLimit: 1,
    generateCheckpoint: checkpointSummary,
  })

  assert.equal(result.failureKind, 'boundary_unavailable')
  assert.equal(control.latestCheckpoint('conversation-1'), undefined)
})
