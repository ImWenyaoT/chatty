// 会话编排状态机（deriveConversationOrchestration）的单元测试：
// 这是 rag-service 的核心纯函数状态机，之前只靠端到端 LLM eval 兜底。
// 这里把「阶段推导优先级、slot 组合矩阵、主动追问上限、纯函数契约」固定下来，
// 改坏任何一条分支都会立刻红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveConversationOrchestration } from './conversation-orchestrator.js';
import type {
  ConversationOrchestration,
  ConversationProfile,
  ConversationStage,
  NextActionType,
  OrderReadiness,
} from './types.js';

const NOW = '2026-07-02T10:00:00.000Z';

// 构造一份「全部就绪」的 OrderReadiness，各用例在此基础上只打开自己关心的缺口
function makeReadiness(overrides: Partial<OrderReadiness> = {}): OrderReadiness {
  return {
    needProductId: false,
    needRentalPeriod: false,
    needHeightWeight: false,
    needSizeRecommendation: false,
    needAvailabilityCheck: false,
    needReviewCheck: false,
    readyToOrder: false,
    updatedAt: NOW,
    ...overrides,
  };
}

// 构造最小可用的 ConversationProfile，默认不带任何已收集信息
function makeProfile(overrides: Partial<ConversationProfile> = {}): ConversationProfile {
  return { updatedAt: NOW, ...overrides };
}

// 构造上一轮编排快照：本轮推导只消费其中的 proactiveFollowUpCount / lastProactiveFollowUpAt
function makePrevOrchestration(count: number): ConversationOrchestration {
  return {
    stage: 'schedule_collecting',
    currentGoal: '',
    pendingSlots: [],
    completedSlots: [],
    blockingIssues: [],
    nextAction: 'ask_rental_period',
    proactiveFollowUpCount: count,
    lastProactiveFollowUpAt: NOW,
    shouldUseRag: false,
    shouldUseBusinessTools: false,
    handoffNeeded: false,
    updatedAt: NOW,
  };
}

// ---------- 阶段推导：表驱动矩阵（锁品 → 档期 → 体型 → 尺码 → 库存 → 复核 → 引导下单 → 兜底） ----------

interface StageCase {
  name: string;
  productId?: string;
  profile?: Partial<ConversationProfile>;
  readiness?: Partial<OrderReadiness>;
  expected: {
    stage: ConversationStage;
    nextAction: NextActionType;
    replyTemplateKey: string;
    shouldUseRag: boolean;
    shouldUseBusinessTools: boolean;
  };
}

const stageCases: StageCase[] = [
  {
    name: '没有任何商品信息 → 锁品阶段（不走 RAG、不动业务工具）',
    readiness: { needProductId: true, needRentalPeriod: true },
    expected: {
      stage: 'product_locking',
      nextAction: 'ask_product',
      replyTemplateKey: 'missing_product',
      shouldUseRag: false,
      shouldUseBusinessTools: false,
    },
  },
  {
    name: '商品已锁但缺档期 → 收档期阶段',
    productId: 'SUIT-001',
    readiness: { needRentalPeriod: true },
    expected: {
      stage: 'schedule_collecting',
      nextAction: 'ask_rental_period',
      replyTemplateKey: 'missing_rental_period',
      shouldUseRag: false,
      shouldUseBusinessTools: false,
    },
  },
  {
    name: '缺身高体重 → 收体型阶段（允许调业务工具）',
    productId: 'SUIT-001',
    readiness: { needHeightWeight: true },
    expected: {
      stage: 'body_collecting',
      nextAction: 'ask_body_measurements',
      replyTemplateKey: 'missing_body_measurements',
      shouldUseRag: false,
      shouldUseBusinessTools: true,
    },
  },
  {
    name: '缺尺码推荐 → 确认尺码阶段（RAG + 业务工具都开）',
    productId: 'SUIT-001',
    readiness: { needSizeRecommendation: true },
    expected: {
      stage: 'size_confirming',
      nextAction: 'confirm_size',
      replyTemplateKey: 'confirm_size',
      shouldUseRag: true,
      shouldUseBusinessTools: true,
    },
  },
  {
    name: '缺库存核验 → 查档期库存阶段',
    productId: 'SUIT-001',
    readiness: { needAvailabilityCheck: true },
    expected: {
      stage: 'availability_checking',
      nextAction: 'check_availability',
      replyTemplateKey: 'check_availability',
      shouldUseRag: true,
      shouldUseBusinessTools: true,
    },
  },
  {
    name: '缺下单前复核 → 复核阶段',
    productId: 'SUIT-001',
    readiness: { needReviewCheck: true },
    expected: {
      stage: 'review_confirming',
      nextAction: 'confirm_review',
      replyTemplateKey: 'confirm_review',
      shouldUseRag: true,
      shouldUseBusinessTools: true,
    },
  },
  {
    name: '全部就绪且 readyToOrder → 引导下单阶段',
    productId: 'SUIT-001',
    readiness: { readyToOrder: true },
    expected: {
      stage: 'order_guiding',
      nextAction: 'guide_order',
      replyTemplateKey: 'ready_to_order',
      shouldUseRag: true,
      shouldUseBusinessTools: true,
    },
  },
  {
    name: '没有任何缺口但也没 readyToOrder → 兜底 intent_discovery（只答题不追问）',
    productId: 'SUIT-001',
    expected: {
      stage: 'intent_discovery',
      nextAction: 'answer_question',
      replyTemplateKey: 'answer_question',
      shouldUseRag: true,
      shouldUseBusinessTools: false,
    },
  },
  {
    name: '优先级契约：档期/体型/尺码同时缺时先收档期',
    productId: 'SUIT-001',
    readiness: { needRentalPeriod: true, needHeightWeight: true, needSizeRecommendation: true },
    expected: {
      stage: 'schedule_collecting',
      nextAction: 'ask_rental_period',
      replyTemplateKey: 'missing_rental_period',
      shouldUseRag: false,
      shouldUseBusinessTools: false,
    },
  },
  {
    name: '没有 productId 但有文字款式意向 → 视为已锁品，直接进下一缺口',
    profile: {
      productIntent: { currentProductText: '黑色双排扣西装', source: 'message', lastMentionedAt: NOW },
    },
    readiness: { needRentalPeriod: true },
    expected: {
      stage: 'schedule_collecting',
      nextAction: 'ask_rental_period',
      replyTemplateKey: 'missing_rental_period',
      shouldUseRag: false,
      shouldUseBusinessTools: false,
    },
  },
];

for (const c of stageCases) {
  test(`阶段推导：${c.name}`, () => {
    const result = deriveConversationOrchestration({
      profile: makeProfile(c.profile),
      orderReadiness: makeReadiness(c.readiness),
      productId: c.productId,
      now: NOW,
    });
    assert.equal(result.stage, c.expected.stage);
    assert.equal(result.nextAction, c.expected.nextAction);
    assert.equal(result.replyTemplateKey, c.expected.replyTemplateKey);
    assert.equal(result.shouldUseRag, c.expected.shouldUseRag);
    assert.equal(result.shouldUseBusinessTools, c.expected.shouldUseBusinessTools);
    assert.equal(result.updatedAt, NOW);
  });
}

// ---------- completedSlots / pendingSlots / blockingIssues 组合矩阵 ----------

test('completedSlots：全量信息齐备时七个 slot 全部点亮', () => {
  const result = deriveConversationOrchestration({
    profile: makeProfile({
      productIntent: { currentProductText: '黑色西装', source: 'message', lastMentionedAt: NOW },
      rentalPeriod: { startDate: '2026-7-10', endDate: '2026-7-12', source: 'message', lastMentionedAt: NOW },
      heightCm: 175,
      weightKg: 70,
      sizeRecommendation: { recommendedSize: 'L', source: 'rule', lastRecommendedAt: NOW },
      availabilityCheck: { hasSchedule: true, hasSize: true, source: 'api', checkedAt: NOW },
      reviewCheck: { needed: true, completed: true, passed: true, source: 'system' },
      orderPlacement: { orderNo: 'XY-20260702-001', placedAt: NOW, source: 'manual' },
    }),
    orderReadiness: makeReadiness(),
    productId: 'SUIT-001',
    now: NOW,
  });
  assert.deepEqual(result.completedSlots, [
    'product',
    'rentalPeriod',
    'bodyMeasurements',
    'sizeRecommendation',
    'availability',
    'review',
    'orderPlaced',
  ]);
});

test('completedSlots：半填信息不点亮（只有起租日/只有身高/库存半确认/复核未通过）', () => {
  const result = deriveConversationOrchestration({
    profile: makeProfile({
      rentalPeriod: { startDate: '2026-7-10', source: 'message', lastMentionedAt: NOW },
      heightCm: 175,
      availabilityCheck: { hasSchedule: true, hasSize: false, source: 'api', checkedAt: NOW },
      reviewCheck: { needed: true, completed: true, passed: false, source: 'system' },
    }),
    orderReadiness: makeReadiness(),
    productId: 'SUIT-001',
    now: NOW,
  });
  // 半填一律不算完成，只有锁品这一项成立
  assert.deepEqual(result.completedSlots, ['product']);
});

test('pendingSlots 与 blockingIssues 跟随 readiness 缺口一一对应', () => {
  const result = deriveConversationOrchestration({
    profile: makeProfile(),
    orderReadiness: makeReadiness({ needProductId: true, needReviewCheck: true }),
    now: NOW,
  });
  assert.deepEqual(result.pendingSlots, ['product', 'review']);
  assert.deepEqual(result.blockingIssues, [
    '还没有锁定具体商品',
    '下单前还需要和用户复核关键信息',
  ]);
});

test('尺码待人工确认：进 blockingIssues 且强制 handoffNeeded', () => {
  const result = deriveConversationOrchestration({
    profile: makeProfile({
      sizeRecommendation: { recommendedSize: '尺码待人工确认', source: 'rule', lastRecommendedAt: NOW },
    }),
    orderReadiness: makeReadiness(),
    productId: 'SUIT-001',
    now: NOW,
  });
  assert.ok(result.blockingIssues.includes('尺码需要人工复核'));
  assert.equal(result.handoffNeeded, true);
  // 没有显式 handoffStatus 时，理由回落到 reviewCheck.failureReason（此处为空）
  assert.equal(result.handoffReason, undefined);
});

test('库存核验半完成：只报缺的那一半（档期已确认、尺码未确认）', () => {
  const result = deriveConversationOrchestration({
    profile: makeProfile({
      availabilityCheck: { hasSchedule: true, hasSize: false, source: 'api', checkedAt: NOW },
    }),
    orderReadiness: makeReadiness({ needAvailabilityCheck: true }),
    productId: 'SUIT-001',
    now: NOW,
  });
  assert.deepEqual(result.blockingIssues, ['尺码还没确认完成']);
});

// ---------- 主动追问上限（PROACTIVE_FOLLOW_UP_LIMIT = 2）边界 ----------

test('追问上限：历史计数 0 和 1 次时不暂停，保留 followUpQuestion', () => {
  for (const count of [0, 1]) {
    const result = deriveConversationOrchestration({
      profile: makeProfile({ orchestration: makePrevOrchestration(count) }),
      orderReadiness: makeReadiness({ needRentalPeriod: true }),
      productId: 'SUIT-001',
      now: NOW,
    });
    assert.equal(result.paused, false);
    assert.ok(result.followUpQuestion, `count=${count} 时应保留追问文案`);
    // 推导只读计数不递增：计数递增由外部在真正发出追问时执行
    assert.equal(result.proactiveFollowUpCount, count);
    assert.equal(result.proactiveFollowUpLimit, 2);
  }
});

test('追问上限：计数达到/超过 2 次时暂停追问，但计数与时间戳原样透传', () => {
  for (const count of [2, 3]) {
    const result = deriveConversationOrchestration({
      profile: makeProfile({ orchestration: makePrevOrchestration(count) }),
      orderReadiness: makeReadiness({ needRentalPeriod: true }),
      productId: 'SUIT-001',
      now: NOW,
    });
    assert.equal(result.paused, true);
    assert.equal(result.followUpQuestion, undefined);
    assert.equal(result.proactiveFollowUpCount, count);
    assert.equal(result.lastProactiveFollowUpAt, NOW);
  }
});

// ---------- 追问文案：开放槽位一次性问全 ----------

test('多个槽位同时缺失时 followUpQuestion 一次性问全，避免割裂追问', () => {
  const result = deriveConversationOrchestration({
    profile: makeProfile(),
    orderReadiness: makeReadiness({ needRentalPeriod: true, needHeightWeight: true, needQuantity: true }),
    productId: 'SUIT-001',
    now: NOW,
  });
  assert.equal(result.stage, 'schedule_collecting');
  assert.ok(result.followUpQuestion!.includes('档期（哪天使用、哪天归还）'));
  assert.ok(result.followUpQuestion!.includes('身高、体重'));
  assert.ok(result.followUpQuestion!.includes('数量'));
});

test('只缺一个槽位时 followUpQuestion 只问那一项', () => {
  const result = deriveConversationOrchestration({
    profile: makeProfile(),
    orderReadiness: makeReadiness({ needRentalPeriod: true }),
    productId: 'SUIT-001',
    now: NOW,
  });
  assert.equal(result.followUpQuestion, '您把档期（哪天使用、哪天归还）发我，我这边继续帮您安排。');
});

// ---------- waitingForUser / handoff / 纯函数契约 ----------

test('waitingForUser：追问类动作等用户，answer_question 不等', () => {
  const asking = deriveConversationOrchestration({
    profile: makeProfile(),
    orderReadiness: makeReadiness({ needProductId: true }),
    now: NOW,
  });
  assert.equal(asking.waitingForUser, true);

  const answering = deriveConversationOrchestration({
    profile: makeProfile(),
    orderReadiness: makeReadiness(),
    productId: 'SUIT-001',
    now: NOW,
  });
  assert.equal(answering.waitingForUser, false);
});

test('handoffStatus.needed 透传为 handoffNeeded，并带上人工介入原因', () => {
  const result = deriveConversationOrchestration({
    profile: makeProfile({
      handoffStatus: { needed: true, reason: '用户要求转人工', createdAt: NOW, source: 'system' },
    }),
    orderReadiness: makeReadiness(),
    productId: 'SUIT-001',
    now: NOW,
  });
  assert.equal(result.handoffNeeded, true);
  assert.equal(result.handoffReason, '用户要求转人工');
});

test('纯函数契约：推导不回写入参 profile（含上一轮 orchestration）', () => {
  const profile = makeProfile({
    orchestration: makePrevOrchestration(1),
    heightCm: 175,
  });
  const snapshot = structuredClone(profile);
  deriveConversationOrchestration({
    profile,
    orderReadiness: makeReadiness({ needRentalPeriod: true }),
    productId: 'SUIT-001',
    now: NOW,
  });
  // 状态推进只体现在返回值里，入参必须保持原样（否则重放/审计会被污染）
  assert.deepEqual(profile, snapshot);
});

test('下单后现状固定：orderPlaced 点亮但 stage 不会推导为 post_order_followup', () => {
  // 注意：decideStage 目前没有任何分支返回 post_order_followup，
  // 即使 orderPlacement 已存在也只落到 intent_discovery（疑似状态机缺口，先固定现状）。
  const result = deriveConversationOrchestration({
    profile: makeProfile({
      orderPlacement: { orderNo: 'XY-20260702-001', placedAt: NOW, source: 'manual' },
    }),
    orderReadiness: makeReadiness(),
    productId: 'SUIT-001',
    now: NOW,
  });
  assert.ok(result.completedSlots.includes('orderPlaced'));
  assert.equal(result.stage, 'intent_discovery');
  assert.equal(result.nextAction, 'answer_question');
});
