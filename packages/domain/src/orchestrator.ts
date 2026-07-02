// slot 状态机（纯函数）。从 legacy rag-service/src/conversation-orchestrator.ts 平移，
// 唯一的刻意行为变更是 docs/architecture.md §8.1：decideStage 补上 post_order_followup
// 分支，让 close_loop 动作可达（legacy 中该阶段是死代码，测试曾钉住这个缺口）。
// 其余分支、文案、优先级顺序与 legacy 逐行等价。

import type {
  AvailabilityCheck,
  ConversationOrchestration,
  ConversationProfile,
  ConversationStage,
  NextActionType,
  OrderReadiness,
  SizeRecommendation,
} from './types.js'

const PROACTIVE_FOLLOW_UP_LIMIT = 2

/** 汇总 profile 里已经收集完成的 slot（半填信息一律不算完成） */
function buildCompletedSlots(profile: ConversationProfile, productId?: string) {
  const slots: string[] = []
  if (productId || profile.productIntent?.currentProductText) {
    slots.push('product')
  }
  if (profile.rentalPeriod?.startDate && profile.rentalPeriod?.endDate) {
    slots.push('rentalPeriod')
  }
  if (profile.heightCm !== undefined && profile.weightKg !== undefined) {
    slots.push('bodyMeasurements')
  }
  if (profile.sizeRecommendation?.recommendedSize) {
    slots.push('sizeRecommendation')
  }
  if (profile.availabilityCheck?.hasSchedule && profile.availabilityCheck?.hasSize) {
    slots.push('availability')
  }
  if (profile.reviewCheck?.completed && profile.reviewCheck?.passed) {
    slots.push('review')
  }
  if (profile.orderPlacement?.orderNo) {
    slots.push('orderPlaced')
  }
  return slots
}

/** 把 OrderReadiness 的缺口一一映射为待收集 slot 列表 */
function buildPendingSlots(readiness: OrderReadiness) {
  const slots: string[] = []
  if (readiness.needProductId) {
    slots.push('product')
  }
  if (readiness.needRentalPeriod) {
    slots.push('rentalPeriod')
  }
  if (readiness.needHeightWeight) {
    slots.push('bodyMeasurements')
  }
  if (readiness.needSizeRecommendation) {
    slots.push('sizeRecommendation')
  }
  if (readiness.needAvailabilityCheck) {
    slots.push('availability')
  }
  if (readiness.needReviewCheck) {
    slots.push('review')
  }
  return slots
}

/** 生成人类可读的阻塞项清单（含尺码待人工确认、库存半确认等细分场景） */
function buildBlockingIssues(
  readiness: OrderReadiness,
  sizeRecommendation?: SizeRecommendation,
  availabilityCheck?: AvailabilityCheck,
) {
  const issues: string[] = []
  if (readiness.needProductId) {
    issues.push('还没有锁定具体商品')
  }
  if (readiness.needRentalPeriod) {
    issues.push('还缺完整租赁日期')
  }
  if (readiness.needHeightWeight) {
    issues.push('还缺身高体重')
  }
  if (sizeRecommendation?.recommendedSize === '尺码待人工确认') {
    issues.push('尺码需要人工复核')
  }
  if (readiness.needAvailabilityCheck) {
    if (!availabilityCheck?.hasSchedule) {
      issues.push('档期还没确认完成')
    }
    if (!availabilityCheck?.hasSize) {
      issues.push('尺码还没确认完成')
    }
  }
  if (readiness.needReviewCheck) {
    issues.push('下单前还需要和用户复核关键信息')
  }
  return issues
}

/** 阶段推导：锁品 → 档期 → 体型 → 尺码 → 库存 → 复核 → 引导下单 → 售后跟进 → 兜底 */
function decideStage(
  readiness: OrderReadiness,
  profile: ConversationProfile,
  productId?: string,
): ConversationStage {
  // §8.1 行为修复（docs/architecture.md）：订单已产生且下单前复核已完成 → 售后跟进阶段。
  // legacy 的 decideStage 没有任何分支返回 post_order_followup，close_loop 是死代码；
  // 重写后此分支置于最前——订单落地后的对话不应再回退到锁品/收档期等前置阶段。
  if (profile.orderPlacement && profile.reviewCheck?.completed) {
    return 'post_order_followup'
  }
  if (!productId && !profile.productIntent?.currentProductText) {
    return 'product_locking'
  }
  if (readiness.needRentalPeriod) {
    return 'schedule_collecting'
  }
  if (readiness.needHeightWeight) {
    return 'body_collecting'
  }
  if (readiness.needSizeRecommendation) {
    return 'size_confirming'
  }
  if (readiness.needAvailabilityCheck) {
    return 'availability_checking'
  }
  if (readiness.needReviewCheck) {
    return 'review_confirming'
  }
  if (readiness.readyToOrder) {
    return 'order_guiding'
  }
  return 'intent_discovery'
}

// 客户给信息没有先后顺序要求，凑齐 衣服 / 身高 / 体重 / 档期 / 数量(默认1) 即可。
// 当多个 slot 都缺失时，followUp 一次性问全，避免出现"先档期再身高体重"那种割裂感。
function buildOpenSlotPrompt(readiness: OrderReadiness): string {
  const parts: string[] = []
  if (readiness.needRentalPeriod) parts.push('档期（哪天使用、哪天归还）')
  if (readiness.needHeightWeight) parts.push('身高、体重')
  if (readiness.needQuantity) parts.push('数量（默认 1 件，要多件麻烦也告诉我）')
  if (parts.length === 0) {
    return '我先帮您把信息再核对一下。'
  }
  if (parts.length === 1) {
    return `您把${parts[0]}发我，我这边继续帮您安排。`
  }
  return `您把${parts.join('、')}发我（顺序不限，方便先告诉我哪个都行），凑齐了我这边一次性帮您对尺码和档期。`
}

/** 阶段 → 下一步动作 / 目标 / 追问文案 / RAG 与业务工具开关 的映射表 */
function decideAction(
  stage: ConversationStage,
  readiness: OrderReadiness,
): {
  nextAction: NextActionType
  currentGoal: string
  followUpQuestion?: string
  replyTemplateKey: string
  shouldUseRag: boolean
  shouldUseBusinessTools: boolean
} {
  switch (stage) {
    case 'product_locking':
      return {
        nextAction: 'ask_product',
        currentGoal: '锁定具体商品或款式',
        followUpQuestion: '您把想租的款式、颜色或者商品编号发我，我先帮您对具体商品。',
        replyTemplateKey: 'missing_product',
        shouldUseRag: false,
        shouldUseBusinessTools: false,
      }
    case 'schedule_collecting':
      return {
        nextAction: 'ask_rental_period',
        currentGoal: '凑齐档期/身高体重/数量（顺序不限）',
        followUpQuestion: buildOpenSlotPrompt(readiness),
        replyTemplateKey: 'missing_rental_period',
        shouldUseRag: false,
        shouldUseBusinessTools: false,
      }
    case 'body_collecting':
      return {
        nextAction: 'ask_body_measurements',
        currentGoal: '凑齐档期/身高体重/数量（顺序不限）',
        followUpQuestion: buildOpenSlotPrompt(readiness),
        replyTemplateKey: 'missing_body_measurements',
        shouldUseRag: false,
        shouldUseBusinessTools: true,
      }
    case 'size_confirming':
      return {
        nextAction: 'confirm_size',
        currentGoal: '确认推荐尺码',
        followUpQuestion: '我先按您这边的信息给您对尺码，您稍等我看一下。',
        replyTemplateKey: 'confirm_size',
        shouldUseRag: true,
        shouldUseBusinessTools: true,
      }
    case 'availability_checking':
      return {
        nextAction: 'check_availability',
        currentGoal: '确认档期和库存是否可安排',
        followUpQuestion: '我这边继续帮您对一下这个尺码的档期和库存。',
        replyTemplateKey: 'check_availability',
        shouldUseRag: true,
        shouldUseBusinessTools: true,
      }
    case 'order_guiding':
      return {
        nextAction: 'guide_order',
        currentGoal: '引导用户完成下单',
        followUpQuestion: '这边信息已经都确认好了，您可以直接下单，我这边继续帮您跟进安排。',
        replyTemplateKey: 'ready_to_order',
        shouldUseRag: true,
        shouldUseBusinessTools: true,
      }
    case 'review_confirming':
      return {
        nextAction: 'confirm_review',
        currentGoal: '和用户复核商品、档期、尺码等关键信息',
        followUpQuestion: '我先帮您把商品、档期和尺码再核对一遍，确认无误您再下单会更稳妥。',
        replyTemplateKey: 'confirm_review',
        shouldUseRag: true,
        shouldUseBusinessTools: true,
      }
    case 'post_order_followup':
      return {
        nextAction: 'close_loop',
        currentGoal: '跟进订单和售后',
        followUpQuestion: '订单这边我已经接上了，接下来我帮您继续核对和跟进。',
        replyTemplateKey: 'post_order_followup',
        shouldUseRag: true,
        shouldUseBusinessTools: true,
      }
    default:
      return {
        nextAction: 'answer_question',
        currentGoal: '先回答当前问题并识别下一步需求',
        replyTemplateKey: 'answer_question',
        shouldUseRag: true,
        shouldUseBusinessTools: false,
      }
  }
}

/**
 * 会话编排推导：由 profile + orderReadiness 纯函数地推出当前阶段、下一步动作、
 * slot 清单与追问策略。不回写任何入参（重放/审计依赖这一点）。
 */
export function deriveConversationOrchestration(input: {
  profile: ConversationProfile
  orderReadiness: OrderReadiness
  productId?: string
  now: string
}): ConversationOrchestration {
  const stage = decideStage(input.orderReadiness, input.profile, input.productId)
  const action = decideAction(stage, input.orderReadiness)
  const previous = input.profile.orchestration
  const previousCount = previous?.proactiveFollowUpCount ?? 0
  const waitingForUser =
    action.nextAction !== 'answer_question' && action.nextAction !== 'close_loop'
  const paused = previousCount >= PROACTIVE_FOLLOW_UP_LIMIT

  return {
    stage,
    currentGoal: action.currentGoal,
    pendingSlots: buildPendingSlots(input.orderReadiness),
    completedSlots: buildCompletedSlots(input.profile, input.productId),
    blockingIssues: buildBlockingIssues(
      input.orderReadiness,
      input.profile.sizeRecommendation,
      input.profile.availabilityCheck,
    ),
    nextAction: action.nextAction,
    followUpQuestion: paused ? undefined : action.followUpQuestion,
    proactiveFollowUpCount: previousCount,
    proactiveFollowUpLimit: PROACTIVE_FOLLOW_UP_LIMIT,
    lastProactiveFollowUpAt: previous?.lastProactiveFollowUpAt,
    waitingForUser,
    paused,
    replyTemplateKey: action.replyTemplateKey,
    shouldUseRag: action.shouldUseRag,
    shouldUseBusinessTools: action.shouldUseBusinessTools,
    handoffNeeded:
      input.profile.sizeRecommendation?.recommendedSize === '尺码待人工确认' ||
      (input.profile.handoffStatus?.needed ?? false),
    handoffReason: input.profile.handoffStatus?.needed
      ? input.profile.handoffStatus.reason
      : input.profile.reviewCheck?.failureReason,
    updatedAt: input.now,
  }
}
