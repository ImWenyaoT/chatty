import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConversationId, createDialogueEngine, type DialogueEnginePorts } from './index.js'
import type { CatalogFile, MemoryCommit, MemorySnapshot } from './index.js'

const now = '2026-07-02T10:00:00.000Z'

const catalog: CatalogFile = {
  products: [
    {
      id: 'SUIT-001',
      name: '黑色双排扣西装',
      dailyPrice: 199,
      renewalDailyPrice: 99.5,
    },
  ],
  sizeRules: [
    {
      size: 'L',
      minHeight: 170,
      maxHeight: 180,
      minWeight: 65,
      maxWeight: 80,
      confidence: 'high',
    },
  ],
  sizeFallback: { size: '尺码待人工确认', confidence: 'low' },
}

/** 构造对话引擎测试用端口，并捕获本轮记忆提交内容。 */
function createPorts(snapshot: MemorySnapshot = emptySnapshot()) {
  const commits: MemoryCommit[] = []
  const ports: DialogueEnginePorts = {
    classify: {
      async classify() {
        return { intent: 'other', mode: 'follow_flow' }
      },
    },
    extract: {
      async extract() {
        return {}
      },
    },
    generate: {
      async generate() {
        return ''
      },
    },
    knowledge: {
      async search() {
        return []
      },
    },
    memory: {
      async snapshot() {
        return snapshot
      },
      async commit(_key, patch) {
        commits.push(patch)
      },
    },
  }
  return { ports, commits }
}

/** 返回无历史消息、无画像的默认记忆快照。 */
function emptySnapshot(): MemorySnapshot {
  return {
    recentMessages: [],
    conversationProfile: undefined,
    bodyProfiles: [],
    summary: '',
    globalSummary: '',
  }
}

test('buildConversationId：按 productId 合成会话键，显式 conversationId 优先', () => {
  assert.equal(buildConversationId('c1', 'SUIT-001'), 'c1:SUIT-001')
  assert.equal(buildConversationId('c1'), 'c1:general')
  assert.equal(buildConversationId('c1', 'SUIT-001', 'custom-thread'), 'custom-thread')
})

test('createDialogueEngine：一轮回答会推进流程并恰好提交一次记忆', async () => {
  const { ports, commits } = createPorts()
  const engine = createDialogueEngine(ports, {
    catalog,
    stylistPrompt: '语气自然，简短。',
    now: () => new Date(now),
  })

  const result = await engine.answer({
    customerId: 'c1',
    productId: 'SUIT-001',
    question: '5月10号到12号，175cm 70kg',
  })

  assert.equal(result.action, 'confirm_review')
  assert.equal(result.answerSource, 'fallback')
  assert.equal(result.stage, 'review_confirming')
  assert.equal(commits.length, 1)
  assert.deepEqual(
    commits[0].appendMessages?.map((message) => message.role),
    ['user', 'assistant'],
  )
  assert.equal(commits[0].conversationProfile?.heightCm, 175)
  assert.equal(commits[0].conversationProfile?.weightKg, 70)
  assert.equal(commits[0].conversationProfile?.rentalPeriod?.startDate, '2026-5-10')
  assert.equal(commits[0].conversationProfile?.rentalPeriod?.endDate, '2026-5-12')
})
