// 画像域逻辑：ConversationProfile / BodyProfile 合并语义、infer* 推进、
// 订单/复核状态推进、summary 确定性重建。
// 平移来源（行为逐字保真，除注明处）：rag-service/src/memory-store.ts
//   - mergeConversationProfile          ← L562-608
//   - buildIncomingProfilePatch         ← L477-560（原 extractConversationProfile；
//       LLM 事实一律由 engine 预抽取传入，不再有"没传就自己调 LLM"的路径）
//   - extractBodyProfilesFromInput      ← L824-895
//   - mergeBodyProfiles                 ← L897-915
//   - inferPriceQuote / inferSizeRecommendation / inferAvailabilityCheck /
//     inferOrderReadiness               ← L666-822（availability 改走 AvailabilityPort）
//   - applyReviewAndHandoffSignals      ← L1355-1435（复核翻转 + 人工接管信号）
//   - applyPostOrderOrchestrationOverride ← L1475-1504
//   - updateProactiveFollowUpState      ← L610-664
//   - applyOrderPlacement               ← L1075-1124（markOrderPlaced 的画像半边）
//   - buildGlobalSummary / buildProductSummary / buildConversationProfileSummary
//                                        ← L917-1025（纯字符串拼接，确认无 LLM 依赖）
// 舍弃项：JSON 文件读写/锁、异步评估 scheduleReview（评测飞轮走 evals/，不再耦合记忆写入）。

import { findProduct, pickSizeByMeasurement, type CatalogFile } from './catalog.js'
import type { StructuredFacts } from './extraction.js'
import { normalizeDateText } from './parsers/date.js'
import {
  extractHeightWeightFromText,
  extractQuantityFromText,
  normalizeNumber,
} from './parsers/measurements.js'
import type { AvailabilityPort } from './ports.js'
import type {
  AvailabilityCheck,
  BodyProfile,
  ConversationProfile,
  MemoryMessage,
  OrderReadiness,
  PriceQuote,
  ProductIntent,
  QuantityInfo,
  RentalPeriod,
  SizeRecommendation,
} from './types.js'

/** 会话级 sessionContext 的值类型（与 legacy ChatRequestBody.sessionContext 一致） */
export type SessionContext = Record<string, string | number | boolean | null>

// ============ 会话画像的增量构建与合并 ============

/**
 * 从本轮消息 + sessionContext + 预抽取事实构建 incoming 画像补丁。
 * 注意：身高体重/件数在记忆路径是无条件正则抽取（legacy 原语义——门控只作用于
 * LLM 事实与路由），rentalPeriod/productIntent 则完全来自 engine 传入的融合事实。
 */
export function buildIncomingProfilePatch(input: {
  question: string
  sessionContext?: SessionContext
  now: string
  existingProfile?: ConversationProfile
  extractedFacts: StructuredFacts
}): Partial<ConversationProfile> {
  const body = extractHeightWeightFromText(input.question)
  const context = input.sessionContext ?? {}
  const rentalPeriodFromText = input.extractedFacts.rentalPeriod
  const productIntentFromText = input.extractedFacts.productIntent

  const rentalPeriod: RentalPeriod | undefined =
    rentalPeriodFromText ||
    (context.rentalStartDate || context.rentalEndDate
      ? {
          startDate:
            typeof context.rentalStartDate === 'string'
              ? normalizeDateText(context.rentalStartDate)
              : undefined,
          endDate:
            typeof context.rentalEndDate === 'string'
              ? normalizeDateText(context.rentalEndDate)
              : undefined,
          source: 'sessionContext',
          lastMentionedAt: input.now,
        }
      : undefined)

  const productIntentText =
    typeof context.productIntentText === 'string'
      ? context.productIntentText.trim()
      : typeof context.productText === 'string'
        ? context.productText.trim()
        : undefined
  const existingProductText = input.existingProfile?.productIntent?.currentProductText?.trim()

  const productIntent: ProductIntent | undefined =
    productIntentFromText ||
    (productIntentText
      ? {
          currentProductText: productIntentText,
          source: 'sessionContext',
          lastMentionedAt: input.now,
        }
      : existingProductText
        ? {
            currentProductText: existingProductText,
            source: input.existingProfile?.productIntent?.source ?? 'manual',
            lastMentionedAt: input.existingProfile?.productIntent?.lastMentionedAt ?? input.now,
          }
        : undefined)

  const quantityCount = extractQuantityFromText(input.question)
  const quantity: QuantityInfo | undefined =
    quantityCount !== undefined
      ? {
          count: quantityCount,
          isExplicit: true,
          source: 'message',
          lastMentionedAt: input.now,
        }
      : undefined

  return {
    heightCm: body.heightCm,
    weightKg: body.weightKg,
    rentalPeriod,
    productIntent,
    quantity,
    updatedAt: input.now,
  }
}

/**
 * 会话画像合并：incoming 覆盖 existing、缺字段保留旧值。
 * 微妙规则（金标依赖，逐字保真）：
 * - rentalPeriod 支持部分更新（只给 endDate 时保留旧 startDate）；
 * - shouldDropExistingProductText：旧商品栏若被体重类文本污染（"60kg"），
 *   在没有新商品意向时直接清掉，而不是继续带着脏值；
 * - reviewCheck 必须保留，否则用户复核确认后下一轮又会被回退。
 */
export function mergeConversationProfile(
  existingProfile: ConversationProfile | undefined,
  incomingProfile: Partial<ConversationProfile>,
  now: string,
): ConversationProfile {
  const incomingProductText = incomingProfile.productIntent?.currentProductText?.trim()
  const existingProductText = existingProfile?.productIntent?.currentProductText?.trim()
  const shouldDropExistingProductText =
    !!existingProductText &&
    /^(?:[0-9]+(?:\.[0-9]+)?\s*(?:kg|斤|cm)|60kg)$/i.test(existingProductText)

  return {
    heightCm: incomingProfile.heightCm ?? existingProfile?.heightCm,
    weightKg: incomingProfile.weightKg ?? existingProfile?.weightKg,
    rentalPeriod: incomingProfile.rentalPeriod
      ? {
          startDate:
            incomingProfile.rentalPeriod.startDate ?? existingProfile?.rentalPeriod?.startDate,
          endDate: incomingProfile.rentalPeriod.endDate ?? existingProfile?.rentalPeriod?.endDate,
          source: incomingProfile.rentalPeriod.source,
          lastMentionedAt: incomingProfile.rentalPeriod.lastMentionedAt,
        }
      : existingProfile?.rentalPeriod,
    productIntent: incomingProfile.productIntent
      ? {
          currentProductText:
            incomingProductText ??
            (shouldDropExistingProductText ? undefined : existingProductText),
          source: incomingProfile.productIntent.source,
          lastMentionedAt: incomingProfile.productIntent.lastMentionedAt,
        }
      : shouldDropExistingProductText
        ? undefined
        : existingProfile?.productIntent,
    quantity: incomingProfile.quantity ?? existingProfile?.quantity,
    priceQuote: incomingProfile.priceQuote ?? existingProfile?.priceQuote,
    sizeRecommendation: incomingProfile.sizeRecommendation ?? existingProfile?.sizeRecommendation,
    availabilityCheck: incomingProfile.availabilityCheck ?? existingProfile?.availabilityCheck,
    orderReadiness: incomingProfile.orderReadiness ?? existingProfile?.orderReadiness,
    orderPlacement: incomingProfile.orderPlacement ?? existingProfile?.orderPlacement,
    handoffStatus: incomingProfile.handoffStatus ?? existingProfile?.handoffStatus,
    // 复核状态必须保留，否则用户在复核阶段确认后下一轮又会被回退到 needed=false
    reviewCheck: incomingProfile.reviewCheck ?? existingProfile?.reviewCheck,
    orchestration: incomingProfile.orchestration ?? existingProfile?.orchestration,
    updatedAt: now,
  }
}

// ============ 体型档案（客户维度） ============

/** 从本轮消息 + sessionContext 抽取体型档案列表（profile<Id>HeightCm 等前缀键约定） */
export function extractBodyProfilesFromInput(input: {
  question: string
  sessionContext?: SessionContext
  now: string
}): BodyProfile[] {
  const profiles: BodyProfile[] = []
  const fromQuestion = extractHeightWeightFromText(input.question)
  if (fromQuestion.heightCm !== undefined || fromQuestion.weightKg !== undefined) {
    profiles.push({
      profileId: 'default',
      label: '默认档案',
      heightCm: fromQuestion.heightCm,
      weightKg: fromQuestion.weightKg,
      source: 'message',
      lastMentionedAt: input.now,
    })
  }

  const context = input.sessionContext ?? {}
  const profilePrefixMap = new Map<string, Partial<BodyProfile>>()
  for (const [key, rawValue] of Object.entries(context)) {
    if (rawValue === null || rawValue === '') {
      continue
    }

    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue)
    const profileMatch = key.match(/^profile([A-Za-z0-9_-]+)(HeightCm|WeightKg|Label)$/)
    if (profileMatch) {
      const profileId = profileMatch[1].toLowerCase()
      const field = profileMatch[2]
      const current = profilePrefixMap.get(profileId) ?? {}
      if (field === 'HeightCm' && Number.isFinite(value)) {
        current.heightCm = normalizeNumber(value)
      }
      if (field === 'WeightKg' && Number.isFinite(value)) {
        current.weightKg = normalizeNumber(value)
      }
      if (field === 'Label') {
        current.label = String(rawValue)
      }
      profilePrefixMap.set(profileId, current)
      continue
    }

    if (key === 'heightCm' || key === 'weightKg') {
      const current = profilePrefixMap.get('default') ?? {}
      if (key === 'heightCm' && Number.isFinite(value)) {
        current.heightCm = normalizeNumber(value)
      }
      if (key === 'weightKg' && Number.isFinite(value)) {
        current.weightKg = normalizeNumber(value)
      }
      profilePrefixMap.set('default', current)
    }
  }

  for (const [profileId, partial] of profilePrefixMap.entries()) {
    if (partial.heightCm === undefined && partial.weightKg === undefined) {
      continue
    }
    profiles.push({
      profileId,
      label: partial.label || (profileId === 'default' ? '默认档案' : `档案 ${profileId}`),
      heightCm: partial.heightCm,
      weightKg: partial.weightKg,
      source: 'sessionContext',
      lastMentionedAt: input.now,
    })
  }

  return profiles
}

/** 体型档案合并：按 profileId 覆盖合并、缺字段保留旧值，按 lastMentionedAt 倒序 */
export function mergeBodyProfiles(
  existingProfiles: BodyProfile[],
  incomingProfiles: BodyProfile[],
): BodyProfile[] {
  const profileMap = new Map(existingProfiles.map((profile) => [profile.profileId, profile]))
  for (const incoming of incomingProfiles) {
    const existing = profileMap.get(incoming.profileId)
    profileMap.set(incoming.profileId, {
      profileId: incoming.profileId,
      label: incoming.label || existing?.label || '默认档案',
      heightCm: incoming.heightCm ?? existing?.heightCm,
      weightKg: incoming.weightKg ?? existing?.weightKg,
      source: incoming.source,
      lastMentionedAt: incoming.lastMentionedAt,
      notes: incoming.notes ?? existing?.notes,
    })
  }

  return Array.from(profileMap.values()).sort((left, right) =>
    right.lastMentionedAt.localeCompare(left.lastMentionedAt),
  )
}

// ============ infer*：由已知信息推进派生 slot ============

/** 由商品目录推价格报价（商品无定价则返回 undefined） */
export function inferPriceQuote(
  catalog: CatalogFile,
  productId: string | undefined,
  now: string,
): PriceQuote | undefined {
  const product = findProduct(catalog, productId)
  if (!product || product.dailyPrice === undefined) {
    return undefined
  }
  return {
    dailyPrice: product.dailyPrice,
    renewalDailyPrice: product.renewalDailyPrice,
    currency: product.currency,
    shippingPolicy: product.shippingPolicy,
    pricingNote: product.pricingNote,
    source: 'manual',
    lastQuotedAt: now,
  }
}

/** 由身高体重推尺码建议；缺项时返回 missingFields 而不是空 */
export function inferSizeRecommendation(
  catalog: CatalogFile,
  profile: ConversationProfile,
  now: string,
): SizeRecommendation | undefined {
  const missingFields: string[] = []
  if (profile.heightCm === undefined) missingFields.push('heightCm')
  if (profile.weightKg === undefined) missingFields.push('weightKg')

  if (missingFields.length > 0) {
    return { missingFields, source: 'rule', lastRecommendedAt: now }
  }

  const picked = pickSizeByMeasurement(
    catalog,
    profile.heightCm as number,
    profile.weightKg as number,
  )
  return {
    recommendedSize: picked.size,
    confidence: picked.confidence,
    source: 'rule',
    lastRecommendedAt: now,
  }
}

/**
 * 库存/档期核验推进：商品+档期+体型齐全时走 AvailabilityPort 查询
 * （legacy 直连 availability-service 占位；重写改注入端口，缺省实现行为等价）。
 */
export async function inferAvailabilityCheck(
  availability: AvailabilityPort,
  profile: ConversationProfile,
  now: string,
  sizeRecommendation?: SizeRecommendation,
  productId?: string,
): Promise<AvailabilityCheck | undefined> {
  const recommendedSize =
    sizeRecommendation?.recommendedSize ?? profile.sizeRecommendation?.recommendedSize
  const hasSchedule = !!profile.rentalPeriod?.startDate && !!profile.rentalPeriod?.endDate
  const hasBodyMeasurements = profile.heightCm !== undefined && profile.weightKg !== undefined

  if (!productId || !hasSchedule || !hasBodyMeasurements) {
    return undefined
  }

  const result = await availability.queryAvailability({
    productId,
    heightCm: profile.heightCm as number,
    weightKg: profile.weightKg as number,
    rentalStartDate: profile.rentalPeriod?.startDate as string,
    rentalEndDate: profile.rentalPeriod?.endDate as string,
  })

  return {
    hasSize: result.available,
    hasInventory: result.available,
    hasSchedule: result.available,
    availableSize: result.availableSize ?? recommendedSize,
    productId,
    rentalStartDate: profile.rentalPeriod?.startDate,
    rentalEndDate: profile.rentalPeriod?.endDate,
    source: result.source,
    checkedAt: result.checkedAt || now,
  }
}

/** 下单就绪度推导：逐项检查缺口并给出 nextStep 文案（已下单会话固定"待复核/待跟进"） */
export function inferOrderReadiness(
  profile: ConversationProfile,
  productId: string | undefined,
  now: string,
  sizeRecommendation?: SizeRecommendation,
  availabilityCheck?: AvailabilityCheck,
): OrderReadiness {
  const reviewCheck = profile.reviewCheck
  if (profile.orderPlacement?.orderNo) {
    const needReviewCheck = !(reviewCheck?.completed && reviewCheck?.passed)
    return {
      needProductId: false,
      needRentalPeriod: false,
      needHeightWeight: false,
      needSizeRecommendation: false,
      needAvailabilityCheck: false,
      needReviewCheck,
      readyToOrder: false,
      nextStep: needReviewCheck ? '已下单待复核' : '已下单待跟进',
      updatedAt: now,
    }
  }

  const hasConfirmedProduct = !!(profile.productIntent?.currentProductText || productId)
  const needProductId = !hasConfirmedProduct
  const needRentalPeriod = !profile.rentalPeriod?.startDate || !profile.rentalPeriod?.endDate
  const needHeightWeight = profile.heightCm === undefined || profile.weightKg === undefined
  const recommendedSize =
    availabilityCheck?.availableSize ??
    profile.availabilityCheck?.availableSize ??
    sizeRecommendation?.recommendedSize ??
    profile.sizeRecommendation?.recommendedSize
  const hasSchedule =
    availabilityCheck?.hasSchedule ?? profile.availabilityCheck?.hasSchedule ?? false
  const hasSize = availabilityCheck?.hasSize ?? profile.availabilityCheck?.hasSize ?? false
  const needSizeRecommendation = !recommendedSize
  const needAvailabilityCheck = !hasSchedule || !hasSize
  const needReviewCheck =
    !needProductId &&
    !needRentalPeriod &&
    !needHeightWeight &&
    !needSizeRecommendation &&
    !needAvailabilityCheck &&
    !(reviewCheck?.completed && reviewCheck?.passed)
  const readyToOrder =
    !needProductId &&
    !needRentalPeriod &&
    !needHeightWeight &&
    !needSizeRecommendation &&
    !needAvailabilityCheck &&
    !needReviewCheck
  // 数量默认 1，所以不参与 readyToOrder 判定，只用于 follow-up 文案
  const needQuantity = !profile.quantity?.isExplicit

  let nextStep = '继续确认需求'
  if (needProductId) {
    nextStep = '确认商品'
  } else if (needRentalPeriod) {
    nextStep = '确认租赁日期'
  } else if (needHeightWeight) {
    nextStep = '确认身高体重'
  } else if (needSizeRecommendation) {
    nextStep = '确认尺码'
  } else if (needAvailabilityCheck) {
    nextStep = '确认档期和库存'
  } else if (needReviewCheck) {
    nextStep = '和用户复核关键信息'
  } else if (readyToOrder) {
    nextStep = '引导下单'
  }

  return {
    needProductId,
    needRentalPeriod,
    needHeightWeight,
    needSizeRecommendation,
    needAvailabilityCheck,
    needReviewCheck,
    needQuantity,
    readyToOrder,
    nextStep,
    updatedAt: now,
  }
}

// ============ 订单 / 复核状态推进 ============

// 复核确认词表：memory-store 记忆路径专用（比 routing 的 isSimpleConfirmation 更宽，
// 两份词表在 legacy 就不同，保持各自原样，勿合并）
const REVIEW_CONFIRM_WORDS = [
  '是',
  '是的',
  '对',
  '对的',
  '嗯',
  '嗯嗯',
  '好的',
  '好',
  '没错',
  '确认',
  '确认了',
  '可以',
  '没问题',
  '就这样',
]

/**
 * 复核翻转 + 人工接管信号应用（纯函数版）：
 * - 上一轮已把用户推到 review_confirming 且本轮回了确认词 → reviewCheck 翻转为通过；
 * - sessionContext.reviewStatus（passed/failed）人工覆写，failed 同时挂起 handoff；
 * - reviewCheck 缺失时补默认（needed:false）；
 * - sessionContext.handoffNeeded / handoffReason 信号写入；显式 null 表示复位。
 */
export function applyReviewAndHandoffSignals(
  profile: ConversationProfile,
  input: {
    question: string
    sessionContext?: SessionContext
    now: string
  },
): ConversationProfile {
  const next: ConversationProfile = { ...profile }
  const now = input.now

  const handoffNeeded = input.sessionContext?.handoffNeeded === true
  const handoffReason =
    typeof input.sessionContext?.handoffReason === 'string'
      ? input.sessionContext.handoffReason.trim()
      : ''
  const reviewStatus =
    typeof input.sessionContext?.reviewStatus === 'string'
      ? input.sessionContext.reviewStatus.trim()
      : ''
  const reviewSummary =
    typeof input.sessionContext?.reviewSummary === 'string'
      ? input.sessionContext.reviewSummary.trim()
      : ''
  const reviewFailureReason =
    typeof input.sessionContext?.reviewFailureReason === 'string'
      ? input.sessionContext.reviewFailureReason.trim()
      : ''

  // === 自动"翻转复核通过"：
  // 上一轮 orchestrator 已经把用户推到了 review_confirming（AI 发了商品/档期/尺码摘要），
  // 这一轮用户回了"好的/对的/没错/可以/没问题"之类 → 视为复核通过
  const prevStageWasReview = next.orchestration?.stage === 'review_confirming'
  const userConfirmed = REVIEW_CONFIRM_WORDS.includes(
    (input.question ?? '').replace(/\s+/g, '').trim(),
  )
  const currentReview = next.reviewCheck
  const alreadyPassed = !!(currentReview?.completed && currentReview?.passed)
  if (!reviewStatus && prevStageWasReview && userConfirmed && !alreadyPassed) {
    next.reviewCheck = {
      needed: true,
      completed: true,
      passed: true,
      reviewedAt: now,
      source: 'system',
      summary: '用户已确认商品、档期、尺码等信息',
    }
  }

  if (reviewStatus) {
    const passed = reviewStatus === 'passed'
    const failed = reviewStatus === 'failed'
    next.reviewCheck = {
      needed: true,
      completed: passed || failed,
      passed,
      reviewedAt: passed || failed ? now : next.reviewCheck?.reviewedAt,
      source: 'manual',
      summary: reviewSummary || next.reviewCheck?.summary,
      failureReason: failed ? reviewFailureReason || '复核未通过' : undefined,
    }
    if (failed) {
      next.handoffStatus = {
        needed: true,
        reason: reviewFailureReason || '复核未通过，需人工接管',
        createdAt: now,
        source: 'system',
      }
    }
  } else if (!next.reviewCheck) {
    next.reviewCheck = {
      needed: false,
      completed: false,
      passed: false,
      source: 'system',
    }
  }

  if (handoffNeeded || handoffReason) {
    next.handoffStatus = {
      needed: handoffNeeded,
      reason: handoffReason || undefined,
      createdAt: now,
      source: 'system',
    }
  } else if (input.sessionContext?.handoffNeeded === null) {
    next.handoffStatus = {
      needed: false,
      createdAt: now,
      source: 'system',
    }
  }

  return next
}

/**
 * 已下单会话的编排覆写：orchestration 强制进 post_order_followup，
 * 目标/追问按"是否还欠复核"分档（handoff 挂起时追问改为物流确认话术）。
 */
export function applyPostOrderOrchestrationOverride(
  profile: ConversationProfile,
  now: string,
): ConversationProfile {
  if (!profile.orderPlacement?.orderNo) return profile
  return {
    ...profile,
    orchestration: {
      ...profile.orchestration,
      stage: 'post_order_followup',
      currentGoal: profile.orderReadiness?.needReviewCheck
        ? '订单已提交，继续完成复核'
        : '跟进已下单客户',
      pendingSlots: profile.orchestration?.pendingSlots ?? [],
      completedSlots: profile.orchestration?.completedSlots ?? [],
      blockingIssues: profile.orchestration?.blockingIssues ?? [],
      nextAction: profile.orderReadiness?.needReviewCheck ? 'confirm_review' : 'close_loop',
      followUpQuestion: profile.handoffStatus?.needed
        ? '这个物流时间我先帮您跟快递确认，确认好马上回您。'
        : profile.orderReadiness?.needReviewCheck
          ? '订单这边已经接上了，我再和您把商品、档期、尺码这些信息核对一下。'
          : profile.orchestration?.followUpQuestion,
      waitingForUser: true,
      paused: false,
      replyTemplateKey: profile.orchestration?.replyTemplateKey ?? 'post_order_followup',
      shouldUseRag: profile.orchestration?.shouldUseRag ?? true,
      shouldUseBusinessTools: profile.orchestration?.shouldUseBusinessTools ?? true,
      handoffNeeded: profile.handoffStatus?.needed ?? false,
      handoffReason: profile.handoffStatus?.reason,
      updatedAt: now,
    },
  }
}

/**
 * 下单打标（markOrderPlaced 的画像半边）：写 orderPlacement、
 * 未复核则保持 reviewCheck 待办、handoff 复位、orderReadiness/orchestration 推进售后。
 * 返回 { profile, confirmationReply }，消息追加与落库由调用方（loop/tool 层）负责。
 */
export function applyOrderPlacement(
  profile: ConversationProfile,
  orderNo: string,
  now: string,
): { profile: ConversationProfile; confirmationReply: string } {
  const orderConfirmationReply = '收到订单，感谢您的信任，我们会按时发货寄到您手上。'
  const existingReview = profile.reviewCheck
  const needPostOrderReview = !(existingReview?.completed && existingReview?.passed)

  const nextProfile: ConversationProfile = {
    ...profile,
    orderPlacement: {
      orderNo,
      placedAt: now,
      source: 'manual',
    },
    reviewCheck: needPostOrderReview
      ? {
          needed: true,
          completed: existingReview?.completed ?? false,
          passed: existingReview?.passed ?? false,
          reviewedAt: existingReview?.reviewedAt,
          source: existingReview?.source ?? 'system',
          summary: existingReview?.summary,
          failureReason: existingReview?.failureReason,
        }
      : existingReview,
    handoffStatus: {
      needed: false,
      createdAt: now,
      source: 'system',
    },
    orderReadiness: profile.orderReadiness
      ? {
          ...profile.orderReadiness,
          needReviewCheck: needPostOrderReview,
          readyToOrder: false,
          nextStep: needPostOrderReview ? '已下单待复核' : '已下单待跟进',
          updatedAt: now,
        }
      : undefined,
    orchestration: profile.orchestration
      ? {
          ...profile.orchestration,
          stage: 'post_order_followup',
          currentGoal: needPostOrderReview ? '订单已提交，继续完成复核' : '跟进已下单客户',
          nextAction: needPostOrderReview ? 'confirm_review' : 'close_loop',
          followUpQuestion: needPostOrderReview
            ? '订单我这边已经接到了，接下来我再和您把商品、档期、尺码这些关键信息核对一下。'
            : orderConfirmationReply,
          waitingForUser: true,
          paused: false,
          handoffNeeded: false,
          handoffReason: undefined,
          updatedAt: now,
        }
      : undefined,
    updatedAt: now,
  }

  return { profile: nextProfile, confirmationReply: orderConfirmationReply }
}

// ============ 主动追问节流 ============

/** 用户这句话是否携带新事实（数字/商品词/档期词/体型词任一命中） */
export function isUserProvidingNewFacts(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return (
    /[0-9]/.test(normalized) ||
    /想租|想要|黑色|白色|双排扣|单排扣|西装|礼服|衬衫|档期|身高|体重|kg|斤|cm|月|日|号/.test(
      normalized,
    )
  )
}

/**
 * 主动追问计数推进：阶段推进或用户给新事实 → 计数清零；本轮真的发出了追问 → +1；
 * 达到上限（默认 2）→ paused，后续不再自动追问。
 * 已知 legacy bug（只记录不复刻）：legacy 传入的 existingProfile 与 nextProfile
 * 是同一对象引用，stageChanged 恒为 false；重写按代码意图传真正的前一轮画像。
 */
export function updateProactiveFollowUpState(input: {
  existingProfile?: ConversationProfile
  nextProfile: ConversationProfile
  question: string
  answer: string
  now: string
}): ConversationProfile {
  const orchestration = input.nextProfile.orchestration
  if (!orchestration) {
    return input.nextProfile
  }

  const previous = input.existingProfile?.orchestration
  const previousCount = previous?.proactiveFollowUpCount ?? 0
  const previousStage = previous?.stage
  const stageChanged = previousStage && previousStage !== orchestration.stage
  const userProvidedNewFacts = isUserProvidingNewFacts(input.question)
  const askedFollowUp =
    !!orchestration.followUpQuestion && input.answer.includes(orchestration.followUpQuestion)

  let proactiveFollowUpCount = previousCount
  if (stageChanged || userProvidedNewFacts) {
    proactiveFollowUpCount = 0
  }
  if (askedFollowUp) {
    proactiveFollowUpCount += 1
  }

  const proactiveFollowUpLimit = orchestration.proactiveFollowUpLimit ?? 2
  const paused = proactiveFollowUpCount >= proactiveFollowUpLimit

  return {
    ...input.nextProfile,
    orchestration: {
      ...orchestration,
      proactiveFollowUpCount,
      proactiveFollowUpLimit,
      lastProactiveFollowUpAt: askedFollowUp ? input.now : orchestration.lastProactiveFollowUpAt,
      waitingForUser: orchestration.waitingForUser,
      paused,
      followUpQuestion: paused ? undefined : orchestration.followUpQuestion,
      updatedAt: input.now,
    },
  }
}

// ============ summary 确定性重建（无 LLM 依赖） ============

/** 客户全局摘要：既有首行 + sessionContext 事实 + 体型档案 + 最近意图，保留最后 3 行 */
export function buildGlobalSummary(
  existingSummary: string,
  sessionContext: SessionContext | undefined,
  question: string,
  bodyProfiles: BodyProfile[],
): string {
  const facts = sessionContext
    ? Object.entries(sessionContext)
        .filter(([, value]) => value !== null && value !== '')
        .filter(([key]) => !/^profile[A-Za-z0-9_-]+(HeightCm|WeightKg|Label)$/.test(key))
        .filter(([key]) => key !== 'heightCm' && key !== 'weightKg')
        .map(([key, value]) => `${key}: ${String(value)}`)
    : []

  const summaryLines: string[] = []
  if (existingSummary.trim()) {
    const firstLine = existingSummary.split('\n').find((line) => line.trim())
    if (firstLine) {
      summaryLines.push(firstLine)
    }
  }
  if (facts.length > 0) {
    summaryLines.push(`客户已知信息: ${facts.join(' | ')}`)
  }
  if (bodyProfiles.length > 0) {
    const profileSummary = bodyProfiles
      .map((profile) => {
        const parts = [profile.label]
        if (profile.heightCm !== undefined) parts.push(`身高${profile.heightCm}cm`)
        if (profile.weightKg !== undefined) parts.push(`体重${profile.weightKg}kg`)
        return parts.join(' ')
      })
      .join(' | ')
    summaryLines.push(`客户体型档案: ${profileSummary}`)
  }
  summaryLines.push(`最近意图: ${question}`)
  return summaryLines.slice(-3).join('\n')
}

/** 会话摘要：既有首行 + 最近用户关注 + 已回复要点，保留最后 3 行 */
export function buildProductSummary(
  existingSummary: string,
  recentMessages: MemoryMessage[],
): string {
  const recentUserMessages = recentMessages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => message.content)

  const recentAssistantMessages = recentMessages
    .filter((message) => message.role === 'assistant')
    .slice(-2)
    .map((message) => message.content)

  const parts = existingSummary.trim() ? [existingSummary.trim().split('\n')[0]] : []
  if (recentUserMessages.length > 0) {
    parts.push(`用户最近关注: ${recentUserMessages.join(' | ')}`)
  }
  if (recentAssistantMessages.length > 0) {
    parts.push(`已回复要点: ${recentAssistantMessages.join(' | ')}`)
  }

  return parts.slice(-3).join('\n')
}

/** 会话画像一行式摘要（身高/体重/档期/商品/数量/尺码/复核/下一步/订单/接管/阶段） */
export function buildConversationProfileSummary(profile: ConversationProfile): string {
  const parts: string[] = []
  if (profile.heightCm !== undefined) {
    parts.push(`身高${profile.heightCm}cm`)
  }
  if (profile.weightKg !== undefined) {
    parts.push(`体重${profile.weightKg}kg`)
  }
  if (profile.rentalPeriod?.startDate || profile.rentalPeriod?.endDate) {
    parts.push(
      `档期${profile.rentalPeriod?.startDate ?? '?'} 到 ${profile.rentalPeriod?.endDate ?? '?'}`,
    )
  }
  if (profile.productIntent?.currentProductText) {
    parts.push(`意向商品${profile.productIntent.currentProductText}`)
  }
  if (profile.quantity?.count !== undefined) {
    const tag = profile.quantity.isExplicit ? '' : '默认'
    parts.push(`数量${tag}${profile.quantity.count}件`)
  }
  if (profile.sizeRecommendation?.recommendedSize) {
    parts.push(`推荐尺码${profile.sizeRecommendation.recommendedSize}`)
  }
  if (profile.reviewCheck) {
    if (profile.reviewCheck.completed && profile.reviewCheck.passed) {
      parts.push('复核已通过')
    } else if (profile.reviewCheck.completed && !profile.reviewCheck.passed) {
      parts.push(
        `复核失败${profile.reviewCheck.failureReason ? `:${profile.reviewCheck.failureReason}` : ''}`,
      )
    } else if (profile.reviewCheck.needed) {
      parts.push('待复核')
    }
  }
  if (profile.orderReadiness?.nextStep) {
    parts.push(`下一步${profile.orderReadiness.nextStep}`)
  }
  if (profile.orderPlacement?.orderNo) {
    parts.push(`订单号${profile.orderPlacement.orderNo}`)
  }
  if (profile.handoffStatus?.needed && profile.handoffStatus.reason) {
    parts.push(`人工接管${profile.handoffStatus.reason}`)
  }
  if (profile.orchestration?.stage) {
    parts.push(`阶段${profile.orchestration.stage}`)
  }
  return parts.join(' | ')
}
