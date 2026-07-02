// 有序 fast-path 规则表：把 legacy action-picker.ts 的 selectAction（L308-599 的
// if 级联）重构为 Array<{name, when, act}>——规则可单测、可插拔，优先级就是数组顺序。
// 判定逻辑逐字保真；仅 LLM decide_reply 的调用改为经 §8.2 合并分类器的 decideMode()。
// 平移来源：
//   - 关键词意图判别            ← rag-service/src/rag/intents.ts（全文平移，仅本文件消费）
//   - evaluateDeliveryUrgency   ← action-picker.ts L51-70
//   - deriveNextProfile         ← action-picker.ts L74-227（按内聚归位到本层：
//       它是路由的"假设本轮事实已写入"预测推演，与真实记忆写入路径 profile.ts 分离）
//   - RULES / selectAction      ← action-picker.ts L336-599
//   - nextActionToAction        ← action-picker.ts L603-683
//   - previewFollowPrompt       ← action-picker.ts L686-703
// 舍弃项：无（图片通道的路由耦合只有 media-request 一句确认话术，文案保留，
// 图片本身的检索/附图门控在 rag.ts 层，已随 RW-1 整体砍除）。

import { findProduct, pickSizeByMeasurement, type CatalogFile } from '../catalog.js'
import type { ProvidedBody, ProvidedPeriod, ProvidedQuantity } from '../extraction.js'
import { deriveConversationOrchestration } from '../orchestrator.js'
import type { KnowledgeHit } from '../ports.js'
import type { Action, ConversationProfile, MemoryMessage } from '../types.js'
import type { ReplyModeDecision } from './classifier.js'

// ============ 关键词意图判别（legacy rag/intents.ts 全文平移） ============

/** 物流/寄达类问题 */
export function isDeliveryQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return /什么时候寄到|什么时间寄到|多久寄到|几号寄到|什么时候发货|什么时间发货|多久发货|几号发货|物流|快递/.test(
    normalized,
  )
}

/** "我身高体重多少来着"——体型档案回忆问题 */
export function isBodyMeasurementRecallQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return (
    normalized.includes('身高') &&
    normalized.includes('体重') &&
    (normalized.includes('多少') ||
      normalized.includes('来着') ||
      normalized.includes('记得') ||
      normalized.includes('几'))
  )
}

/** 纯确认短语（"对"/"好的"）——routing 专用词表，比 profile.ts 复核词表窄，保持各自原样 */
export function isSimpleConfirmation(question: string): boolean {
  const normalized = question.replace(/\s+/g, '').trim()
  return ['是', '是的', '对', '对的', '嗯', '嗯嗯', '好的', '好', '没错'].includes(normalized)
}

/** 上一条客服是否在等身高体重确认 */
export function isPendingBodyMeasurementConfirmation(lastAssistantMessage?: string): boolean {
  if (!lastAssistantMessage) return false
  return (
    lastAssistantMessage.includes('我先帮您记下') &&
    lastAssistantMessage.includes('身高') &&
    lastAssistantMessage.includes('体重')
  )
}

/** 上一条客服是否在等档期确认 */
export function isPendingRentalPeriodConfirmation(lastAssistantMessage?: string): boolean {
  if (!lastAssistantMessage) return false
  return (
    lastAssistantMessage.includes('先帮您记下档期') ||
    lastAssistantMessage.includes('先帮您把档期改成')
  )
}

/** 打招呼短语 */
export function isGreetingQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '').trim()
  return ['在吗', '在不在', '有人吗', '你好', '您好', '哈喽', 'hi', 'hello'].includes(
    normalized.toLowerCase(),
  )
}

/** 泛泛"想租衣服"（未指定具体款式） */
export function isGenericRentIntent(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return /我想租衣服|想租衣服|租衣服|想租个衣服|我想租个衣服/.test(normalized)
}

/**
 * "有哪些款式 / 都有什么款 / 都卖什么 / 有几款"——用户在问商品清单，
 * 不是在指定具体商品，也不是在给档期，绝对不能被档期追问截胡
 */
export function isCatalogListQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  if (
    /有哪些款|都有哪些款|有什么款|都有什么款|什么款式|哪些款式|有哪几款|几款可选|几款能租|几种款式/.test(
      normalized,
    )
  ) {
    return true
  }
  // "有哪些/都有什么/卖什么/有什么" + 款式/款/商品/衣服 任一组合
  return /(有|卖|都有|都卖|有什么|都有什么|有哪些|都有哪些).{0,6}(款式|款|商品|衣服|西装|礼服|样式|选择|可选)/.test(
    normalized,
  )
}

/**
 * 用户在要图片/照片/实拍图/款式图/效果图——只需一句简短确认话语，
 * 绝对不要借机又去追档期（"我要图你发档期"体验极差）
 */
export function isMediaRequestQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return (
    /(照片|图片|实拍|样图|效果图|款式图|细节图|上身图|模特图).{0,3}(发我|发过来|给我|来一张|来看看|看一下|看看|有没有|有吗|有嘛|瞅瞅)/.test(
      normalized,
    ) ||
    /(发我|给我|来|来一?张|来看看|看一下|看看|有没有|有).{0,3}(照片|图片|图|实拍|样图|效果图|款式图|细节图|上身图)/.test(
      normalized,
    )
  )
}

/** 怎么租/租赁流程类问题 */
export function isRentalHowToQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return /怎么租|如何租|租赁流程|怎么下单|怎么拍|租衣服怎么租/.test(normalized)
}

/** 下单意图 */
export function isOrderQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return /下单|拍下|能买吗|可以租吗|能下单吗|可以下单吗/.test(normalized)
}

/** 价格类问题 */
export function isPriceQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return /价格|多少钱|租金|费用/.test(normalized)
}

/**
 * 用户在问"尺码政策"——如"可以选尺码吗 / 尺码怎么选 / 不合适怎么办 / 能换码吗"。
 * 需正面回答尺码规则，而不是把客户推去问档期/身高体重。
 * 注意排除"我穿 L 码"之类陈述句（那是客户在告知信息，走 follow_flow）。
 */
export function isSizeQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  if (!/尺码|尺寸|码数|大小|码/.test(normalized)) return false
  // 询问语气 / 政策类问句
  if (
    /(?:可以|能|能不能|可不可以|怎么|如何|怎样|要怎么|怎么样|有没有|是否).{0,4}(?:选|挑|推荐|定|确认|换|改|决定|配|看|对|知道|测|量).{0,4}(?:尺码|尺寸|码|大小)/.test(
      normalized,
    )
  ) {
    return true
  }
  if (
    /(?:尺码|尺寸|码|大小).{0,6}(?:怎么|如何|怎样|可以|能|不合适|不合身|有问题|偏[大小]|偏码|换|改|测|量|定)/.test(
      normalized,
    )
  ) {
    return true
  }
  // "选尺码""挑尺码""定尺码"短句
  if (/^(?:选|挑|定|测|量)(?:尺码|尺寸|码|大小)[?？]?$/.test(normalized)) {
    return true
  }
  return false
}

/** "就是当前链接这款"类确认 */
export function isCurrentLinkProductQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '')
  return /当前的链接商品|当前链接商品|就是这款|就是当前这款|就是链接这款|链接这款|当前这个链接/.test(
    normalized,
  )
}

/** 用户示意"没听懂"/请求澄清。优先级最高，在所有业务分支之前处理 */
export function isRepairQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, '').trim()
  if (normalized.length === 0) return false
  if (['?', '？', '??', '？？'].includes(normalized)) return true
  return /没听懂|啥意思|什么意思|不明白|再说一遍|再说一次|没看懂|没太明白|听不懂/.test(normalized)
}

// ============ 路由上下文 ============

/** 一条规则的判定/执行输入：本轮问题 + 画像 + 抽取事实 + 目录 + 惰性 mode 判定 */
export interface RuleContext {
  question: string
  productId?: string
  conversationProfile?: ConversationProfile
  bodyProfilesLabels: string[]
  bodyProfilesCount: number
  lastAssistantMessage?: string
  effectiveProductText?: string
  references: KnowledgeHit[]
  /** 最近几轮对话消息（generation 层拼上下文用） */
  recentMessages?: MemoryMessage[]
  /** 用户本轮消息里抽到的结构化事实 */
  providedBody?: ProvidedBody
  providedPeriod?: ProvidedPeriod
  providedQuantity?: ProvidedQuantity
  /** 商品目录（尺码规则/价格） */
  catalog: CatalogFile
  /** 本轮时间戳（ISO），推演与物流紧迫度判断的"今天"基准 */
  now: string
  /** §8.2 惰性回复模式判定：至多触发一次合并分类端口调用 */
  decideMode: () => Promise<ReplyModeDecision>
}

// ============ 辅助推演 ============

/** 判断下单后物流问题是否需要转人工。开始使用日期距今 <2 天 → 人工跟进（常规"前一天寄到"已来不及） */
export function evaluateDeliveryUrgency(
  rentalStartDate: string | undefined,
  now: string,
): { needsHandoff: boolean; handoffReason?: string } {
  if (!rentalStartDate) return { needsHandoff: false }
  const match = rentalStartDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!match) return { needsHandoff: false }
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(start.getTime())) return { needsHandoff: false }
  const current = new Date(now)
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate())
  const diffDays = Math.floor((start.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  if (diffDays < 2) {
    return {
      needsHandoff: true,
      handoffReason: `客户已下单，租赁开始时间 ${rentalStartDate} 较近，需人工确认物流时效。`,
    }
  }
  return { needsHandoff: false }
}

/**
 * 对 profile 做一次"假设本轮用户提供的事实已经写入"的推演，跑一次 orchestrator。
 * 这样当用户一口气把身高体重/档期给全时，这一轮就能直接走 guide_order/confirm_review。
 * 含 availabilityCheck 乐观推断（三项齐全+有尺码建议 → 乐观认为档期可用），
 * 与真实记忆路径的 inferAvailabilityCheck（走 AvailabilityPort）刻意分离。
 */
export function deriveNextProfile(ctx: RuleContext): ConversationProfile {
  const now = ctx.now
  const existing = ctx.conversationProfile

  const heightCm = ctx.providedBody?.heightCm ?? existing?.heightCm
  const weightKg = ctx.providedBody?.weightKg ?? existing?.weightKg
  const rentalPeriod = ctx.providedPeriod
    ? {
        startDate: ctx.providedPeriod.startDate ?? existing?.rentalPeriod?.startDate,
        endDate: ctx.providedPeriod.endDate ?? existing?.rentalPeriod?.endDate,
        source: existing?.rentalPeriod?.source ?? ('message' as const),
        lastMentionedAt: existing?.rentalPeriod?.lastMentionedAt ?? now,
      }
    : existing?.rentalPeriod
  const productIntent = ctx.effectiveProductText
    ? {
        currentProductText: ctx.effectiveProductText,
        source: existing?.productIntent?.source ?? ('message' as const),
        lastMentionedAt: existing?.productIntent?.lastMentionedAt ?? now,
      }
    : existing?.productIntent

  // 数量：本轮指定 > 已有显式值 > 默认 1（默认值不计为"显式"）
  const existingQty = existing?.quantity
  const providedQty = ctx.providedQuantity?.count
  const quantity =
    providedQty !== undefined
      ? {
          count: providedQty,
          isExplicit: true,
          source: 'message' as const,
          lastMentionedAt: now,
        }
      : existingQty?.isExplicit
        ? existingQty
        : {
            count: 1,
            isExplicit: false,
            source: 'default' as const,
            lastMentionedAt: existingQty?.lastMentionedAt ?? now,
          }

  const sizeRec =
    heightCm !== undefined && weightKg !== undefined
      ? pickSizeByMeasurement(ctx.catalog, heightCm, weightKg)
      : undefined

  const hasProduct = !!(productIntent?.currentProductText || ctx.productId)
  const hasPeriod = !!(rentalPeriod?.startDate && rentalPeriod?.endDate)
  const hasBody = heightCm !== undefined && weightKg !== undefined

  // 推断 availabilityCheck：三项齐全 + 有尺码建议 → 乐观认为档期可用
  // 复用已存在的 availabilityCheck.availableSize（如果用户之前已经核过档期库存就别丢）
  const existingCheck = existing?.availabilityCheck
  const existingAvailableSize = existingCheck?.availableSize
  const effectiveSize = existingAvailableSize ?? sizeRec?.size
  // 注意："尺码待人工确认"也算有效——虽然精确尺码待人工复核，但客服可以先带用户走完复核+下单流程，
  // 否则尺码一兜底立即卡死，永远到不了 review_confirming / order_guiding
  const hasValidSize = !!effectiveSize
  const canCompleteAvailability = hasProduct && hasPeriod && hasBody && hasValidSize

  const availabilityCheck = canCompleteAvailability
    ? {
        hasSize: true,
        hasInventory: true,
        hasSchedule: true,
        availableSize: effectiveSize,
        productId: ctx.productId ?? existingCheck?.productId,
        rentalStartDate: rentalPeriod?.startDate,
        rentalEndDate: rentalPeriod?.endDate,
        source: (existingCheck?.source ?? 'api') as 'knowledge' | 'manual' | 'api',
        checkedAt: existingCheck?.checkedAt || now,
      }
    : existingCheck

  // === 复核阶段状态推演 ===
  // 条件齐了之后必须过一遍"复核"——先向用户朗读 商品/档期/尺码 摘要，
  // 用户确认（好的/对的/没错）才算 reviewCheck.passed=true，然后才能 guide_order
  const existingReview = existing?.reviewCheck
  const reviewAlreadyPassed = !!(existingReview?.completed && existingReview?.passed)
  const prereqsOk = hasProduct && hasPeriod && hasBody && hasValidSize && canCompleteAvailability
  const lastStage = existing?.orchestration?.stage
  const userConfirmedNow =
    prereqsOk &&
    !reviewAlreadyPassed &&
    lastStage === 'review_confirming' &&
    isSimpleConfirmation(ctx.question)

  const reviewCheck = reviewAlreadyPassed
    ? existingReview
    : userConfirmedNow
      ? {
          needed: true,
          completed: true,
          passed: true,
          reviewedAt: now,
          source: 'system' as const,
          summary: '用户已确认商品/档期/尺码',
        }
      : prereqsOk
        ? {
            needed: true,
            completed: existingReview?.completed ?? false,
            passed: existingReview?.passed ?? false,
            source: (existingReview?.source ?? 'system') as 'system' | 'manual',
            reviewedAt: existingReview?.reviewedAt,
            summary: existingReview?.summary,
          }
        : existingReview
  const reviewDone = !!(reviewCheck?.completed && reviewCheck?.passed)

  const orderReadiness = {
    needProductId: !hasProduct,
    needRentalPeriod: !hasPeriod,
    needHeightWeight: !hasBody,
    needSizeRecommendation: !hasValidSize,
    needAvailabilityCheck: !availabilityCheck?.hasSchedule || !availabilityCheck?.hasSize,
    needReviewCheck: prereqsOk && !reviewDone,
    needQuantity: !quantity.isExplicit, // 文案 hint 用，不参与下单门槛
    readyToOrder: prereqsOk && reviewDone,
    nextStep: '',
    updatedAt: now,
  }

  const next: ConversationProfile = {
    ...existing,
    heightCm,
    weightKg,
    rentalPeriod,
    productIntent,
    quantity,
    sizeRecommendation: sizeRec
      ? {
          recommendedSize: sizeRec.size,
          confidence: sizeRec.confidence,
          source: 'rule' as const,
          lastRecommendedAt: now,
        }
      : existing?.sizeRecommendation,
    availabilityCheck,
    reviewCheck,
    orderReadiness,
    updatedAt: now,
  }

  next.orchestration = deriveConversationOrchestration({
    profile: next,
    orderReadiness,
    productId: ctx.productId,
    now,
  })

  return next
}

/** orchestrator 的 nextAction → Action 枚举 */
export function nextActionToAction(profile: ConversationProfile): Action | undefined {
  const orch = profile.orchestration
  const readiness = profile.orderReadiness
  if (!orch || !readiness) return undefined

  const priceQuote = profile.priceQuote
  const productText = profile.productIntent?.currentProductText
  const size = profile.sizeRecommendation?.recommendedSize
  const start = profile.rentalPeriod?.startDate
  const end = profile.rentalPeriod?.endDate
  const qty = profile.quantity?.count ?? 1
  const quantityIsDefault = !profile.quantity?.isExplicit
  const missingBody = !!readiness.needHeightWeight
  const missingPeriod = !!readiness.needRentalPeriod
  const missingQuantity = !!readiness.needQuantity

  if (readiness.readyToOrder) {
    return {
      kind: 'guide_order',
      size,
      startDate: start,
      endDate: end,
      dailyPrice: priceQuote?.dailyPrice,
      quantity: qty,
      quantityIsDefault,
    }
  }

  switch (orch.nextAction) {
    case 'ask_product':
      return { kind: 'ask_product' }
    case 'ask_rental_period':
      return { kind: 'ask_period', productText, missingBody, missingQuantity }
    case 'ask_body_measurements':
      return {
        kind: 'ask_body',
        startDate: start,
        endDate: end,
        knownHeightCm: profile.heightCm,
        knownWeightKg: profile.weightKg,
        missingPeriod,
        missingQuantity,
      }
    case 'confirm_size':
      return size
        ? { kind: 'confirm_size', size }
        : {
            kind: 'ask_body',
            startDate: start,
            endDate: end,
            knownHeightCm: profile.heightCm,
            knownWeightKg: profile.weightKg,
            missingPeriod,
            missingQuantity,
          }
    case 'check_availability':
      return { kind: 'check_availability' }
    case 'confirm_review':
      return {
        kind: 'confirm_review',
        productText,
        startDate: start,
        endDate: end,
        size,
        quantity: qty,
        quantityIsDefault,
      }
    case 'guide_order':
      return {
        kind: 'guide_order',
        size,
        startDate: start,
        endDate: end,
        dailyPrice: priceQuote?.dailyPrice,
        quantity: qty,
        quantityIsDefault,
      }
    default:
      return undefined
  }
}

/** 给 answer_faq / quote_price 做"回答完顺便推半句"的预览文案 */
export function previewFollowPrompt(action: Action): string | undefined {
  switch (action.kind) {
    case 'ask_product':
      return '您先把具体款式或者商品编号发我。'
    case 'ask_period':
      return '您把哪天使用、哪天归还发我。'
    case 'ask_body':
      return '您再把身高和体重发我，这边帮您看尺码。'
    case 'confirm_size':
      return `尺码这边按 ${action.size} 码给您配。`
    case 'confirm_review':
      return '信息都对的话我这边继续给您往下安排。'
    case 'guide_order':
      return '您这边直接下单就行。'
    default:
      return undefined
  }
}

/**
 * 判定"款式已锁定"（默认款式 = 客户进入时绑定的 productId，来自商品链接）：
 *   1) 链接绑定了 productId（默认款，最常见）
 *   2) productIntent 来源是用户消息（中途换了款 / 主动指定了款）
 *   3) 客户已给过档期 / 身高 / 体重（隐含款式已定）
 *   4) 已下单（最强信号）
 */
function isProductConfirmed(ctx: RuleContext): boolean {
  const profile = ctx.conversationProfile
  return (
    !!ctx.productId ||
    profile?.productIntent?.source === 'message' ||
    profile?.rentalPeriod?.startDate !== undefined ||
    profile?.heightCm !== undefined ||
    profile?.weightKg !== undefined ||
    !!profile?.orderPlacement?.orderNo
  )
}

// ============ 有序规则表 ============

export interface RoutingRule {
  /** 达意的规则名（可观测：selectAction 返回命中的规则名） */
  name: string
  /** 判定（同步、纯函数） */
  when: (ctx: RuleContext) => boolean
  /** 产出 Action（可能需要惰性 mode 判定，故允许异步） */
  act: (ctx: RuleContext) => Action | Promise<Action>
}

/**
 * fast-path 规则表。数组顺序 = 优先级 = legacy if 级联的原始顺序（1→13，含 5.5/5.6/8.5）。
 * 最后一条 'llm-mode-fallback' 的 when 恒真，保证 selectAction 必有产出。
 */
export const RULES: RoutingRule[] = [
  {
    // 1. 最高优先级：repair（"没听懂"/"？"/澄清）——不推进状态机
    name: 'repair-does-not-advance',
    when: (ctx) => isRepairQuestion(ctx.question),
    act: (ctx) => {
      // hint 用「上一轮真正说过的那句话」的首句，而不是 followUpQuestion（那是"下一步该问什么"的前瞻，
      // 含身高体重/下单，会让 repair 越界推进）。再净化掉含"下单/身高/体重"的句子，
      // 守住 repair「不推进状态机」的契约；都被净化掉则用中性兜底。
      const last = ctx.lastAssistantMessage ?? ''
      // 上一轮已经是澄清(repair)句 → 客户连着没听懂，本轮升级为更具体/举例的说法，避免逐字复读。
      const escalate = /不好意思|没说清楚|说得不清楚|没讲清楚/.test(last)
      const lastSaid = last
        .split(/[。！？\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const cleanHint = lastSaid.find((s) => !/下单|身高|体重/.test(s))
      const hint = cleanHint || '您方才那条信息再发我一下就行'
      return { kind: 'repair', hint, escalate }
    },
  },
  {
    // 2. 已下单 + 物流相关 → 物流回复（近日期转人工）
    name: 'post-order-delivery',
    when: (ctx) =>
      !!ctx.conversationProfile?.orderPlacement?.orderNo && isDeliveryQuestion(ctx.question),
    act: (ctx) => {
      const start = ctx.conversationProfile?.rentalPeriod?.startDate
      const { needsHandoff, handoffReason } = evaluateDeliveryUrgency(start, ctx.now)
      return { kind: 'post_order_delivery', rentalStartDate: start, needsHandoff, handoffReason }
    },
  },
  {
    // 3. 打招呼
    name: 'greet',
    when: (ctx) => isGreetingQuestion(ctx.question),
    act: () => ({ kind: 'greet' }),
  },
  {
    // 4. 已下单 + 非物流/价格/流程 → 已下单跟进（避免被推回前置 stage）
    name: 'post-order-followup',
    when: (ctx) =>
      !!ctx.conversationProfile?.orderPlacement?.orderNo &&
      !isPriceQuestion(ctx.question) &&
      !isRentalHowToQuestion(ctx.question),
    act: () => ({ kind: 'post_order_followup' }),
  },
  {
    // 5. 泛泛"想租衣服"且没商品 → 要求款式
    name: 'generic-rent-needs-product',
    when: (ctx) => isGenericRentIntent(ctx.question) && !ctx.effectiveProductText,
    act: () => ({ kind: 'ask_product' }),
  },
  {
    // 5.5 "有哪些款式/都有什么款"——商品目录查询，必须在档期推进之前拦截。
    // 否则 follow_flow 会把它推去 ask_period，用户会困惑"我问款式你问我档期"。
    name: 'catalog-list-question',
    when: (ctx) => isCatalogListQuestion(ctx.question),
    act: async (ctx) => {
      const decision = await ctx.decideMode()
      const faqText = (decision.faqAnswer || '').trim()
      const text =
        faqText ||
        '这边在租的款式有好几款，您对颜色或样式有偏好吗？比如双排扣、单排扣、深色还是浅色，我按您的喜好给您挑。'
      return { kind: 'answer_faq', text, orchestrationFollowUp: undefined }
    },
  },
  {
    // 5.6 "照片发我/实拍图/款式图"——只给一句简短确认；未确认款式时 followUp
    // 引导继续选款，不要追问档期。（图片检索/附图通道已随 RW-1 砍除，确认话术保留）
    name: 'media-request-brief-ack',
    when: (ctx) => isMediaRequestQuestion(ctx.question),
    act: (ctx) => {
      const productConfirmed = isProductConfirmed(ctx)
      const text = productConfirmed
        ? '好，图给您发过来了，您看看合不合适。'
        : '好，图给您发过来了，看看这款合不合心意。'
      const followUp = productConfirmed ? undefined : '合适的话我帮您记下这款，再给您对后面的档期。'
      return { kind: 'answer_faq', text, orchestrationFollowUp: followUp }
    },
  },
  {
    // 6. 怎么租
    name: 'rental-howto',
    when: (ctx) => isRentalHowToQuestion(ctx.question),
    act: (ctx) => {
      const priceQuote = ctx.conversationProfile?.priceQuote
      return {
        kind: 'rental_howto',
        productId: ctx.productId,
        dailyPrice: priceQuote?.dailyPrice,
        renewalDailyPrice: priceQuote?.renewalDailyPrice,
        shippingPolicy: priceQuote?.shippingPolicy,
      }
    },
  },
  {
    // 7. "当前链接这款" + 有商品上下文
    name: 'current-link-confirm',
    when: (ctx) =>
      isCurrentLinkProductQuestion(ctx.question) && !!(ctx.productId || ctx.effectiveProductText),
    act: (ctx) => {
      const priceQuote = ctx.conversationProfile?.priceQuote
      return {
        kind: 'current_link_confirm',
        productText: ctx.effectiveProductText,
        productId: ctx.productId,
        dailyPrice: priceQuote?.dailyPrice,
        renewalDailyPrice: priceQuote?.renewalDailyPrice,
      }
    },
  },
  {
    // 8. 身高体重回忆（单档案时不拦截，落到 LLM 兜底直接回）
    name: 'recall-body',
    when: (ctx) => isBodyMeasurementRecallQuestion(ctx.question) && ctx.bodyProfilesCount !== 1,
    act: (ctx) => {
      if (ctx.bodyProfilesCount === 0) return { kind: 'recall_body_empty' }
      return { kind: 'recall_body_ambiguous', labels: ctx.bodyProfilesLabels }
    },
  },
  {
    // 8.5 尺码政策问题——正面回答尺码规则（按身高体重配 + 免费换码），
    // 不能被 LLM 兜底误推到档期/选款。已有身高体重 → 直接给推荐尺码
    name: 'size-policy-question',
    when: (ctx) => isSizeQuestion(ctx.question),
    act: (ctx) => {
      const profile = ctx.conversationProfile
      const hasBody = profile?.heightCm !== undefined && profile?.weightKg !== undefined
      const sizePolicy = '尺码这边按您的身高体重给您配，到手不合身的话我们支持免费换码。'
      if (hasBody) {
        const picked = pickSizeByMeasurement(
          ctx.catalog,
          profile!.heightCm as number,
          profile!.weightKg as number,
        )
        const sizeLine =
          picked.size === '尺码待人工确认'
            ? '您这个身高体重稍微偏一点，我让人工再帮您核对一下码。'
            : `按您 ${profile!.heightCm}cm / ${profile!.weightKg}kg，这款您穿 ${picked.size} 更合适。`
        return {
          kind: 'answer_faq',
          text: `${sizePolicy}${sizeLine}`,
          orchestrationFollowUp: undefined,
        }
      }
      return {
        kind: 'answer_faq',
        text: sizePolicy,
        orchestrationFollowUp: '您把身高体重发我，我这边马上帮您看尺码。',
      }
    },
  },
  {
    // 9. 价格 + 还有流程要走 → 先报价 + 追加下一步提示
    name: 'quote-price-with-next-step',
    when: (ctx) => isPriceQuestion(ctx.question),
    act: (ctx) => {
      const priceQuote = ctx.conversationProfile?.priceQuote
      const nextProfile = deriveNextProfile(ctx)
      const follow = nextActionToAction(nextProfile)
      const nextPrompt = follow ? previewFollowPrompt(follow) : undefined
      return {
        kind: 'quote_price',
        dailyPrice: priceQuote?.dailyPrice,
        renewalDailyPrice: priceQuote?.renewalDailyPrice,
        shippingPolicy: priceQuote?.shippingPolicy,
        nextPrompt,
      }
    },
  },
  {
    // 10. 用户本轮提供了新信息（身高体重/档期/款式/数量）→ 根据预测 profile 推下一步
    // （含 10.0 未锁款先 ask_product、10a 异常体型数据先礼貌确认不强推）
    name: 'provided-facts-advance',
    when: (ctx) => !!(ctx.providedBody || ctx.providedPeriod || ctx.providedQuantity),
    act: (ctx) => {
      // 10.0 款式还没锁定前不能推进体型/档期流程——这只在没有 productId 也没有
      // 用户主动选款时才发生（极少数情况，进入入口未绑定商品的场景）
      if (!isProductConfirmed(ctx)) {
        return { kind: 'ask_product' }
      }
      // 10a. 异常数据先礼貌确认，不强推
      if (ctx.providedBody) {
        const { heightCm, weightKg } = ctx.providedBody
        const existingHeight = ctx.conversationProfile?.heightCm
        // 用户给的体重 > 120kg，且没同时给身高，很可能单位写错（175kg 更像 175cm 或 175 斤）
        if (
          weightKg !== undefined &&
          weightKg > 120 &&
          heightCm === undefined &&
          existingHeight === undefined
        ) {
          return { kind: 'confirm_body_anomaly', weightKg, suspicion: 'weight_too_high' }
        }
        // 身高 > 220cm 或 < 100cm 几乎肯定笔误
        if (heightCm !== undefined && heightCm > 220) {
          return { kind: 'confirm_body_anomaly', heightCm, suspicion: 'height_too_high' }
        }
        if (heightCm !== undefined && heightCm < 100) {
          return { kind: 'confirm_body_anomaly', heightCm, suspicion: 'height_too_low' }
        }
        // 旁通：已有数据 + 本轮只提供一项 → 合并后的数据由 deriveNextProfile 处理
      }
      const nextProfile = deriveNextProfile(ctx)
      const action = nextActionToAction(nextProfile)
      // legacy 此处 action 为空会继续落到后续分支；规则表里用 fallback 规则兜住同样语义
      return action ?? fallthroughToModeFallback(ctx)
    },
  },
  {
    // 11. 纯确认（"对"/"好的"）+ 上一条客服在确认资料 → 推下一步
    name: 'confirmation-advances-pending',
    when: (ctx) =>
      isSimpleConfirmation(ctx.question) &&
      (isPendingBodyMeasurementConfirmation(ctx.lastAssistantMessage) ||
        isPendingRentalPeriodConfirmation(ctx.lastAssistantMessage)),
    act: (ctx) => {
      const nextProfile = deriveNextProfile(ctx)
      const action = nextActionToAction(nextProfile)
      return action ?? fallthroughToModeFallback(ctx)
    },
  },
  {
    // 12. 下单意图 + 已满足 → 直接 guide_order。已正式复核，或三项齐全但用户主动问
    // "能否下单"（视作隐含确认）→ 直接引导下单，避免卡在 confirm_review 反复复核
    name: 'order-question-guides-order',
    when: (ctx) => isOrderQuestion(ctx.question),
    act: (ctx) => {
      const nextProfile = deriveNextProfile(ctx)
      const orderReadiness = nextProfile.orderReadiness
      const orderedAlready = !!ctx.conversationProfile?.orderPlacement?.orderNo
      if (orderReadiness?.readyToOrder || (!orderedAlready && orderReadiness?.needReviewCheck)) {
        const priceQuote = ctx.conversationProfile?.priceQuote
        return {
          kind: 'guide_order',
          size: nextProfile.sizeRecommendation?.recommendedSize,
          startDate: nextProfile.rentalPeriod?.startDate,
          endDate: nextProfile.rentalPeriod?.endDate,
          dailyPrice: priceQuote?.dailyPrice ?? findProduct(ctx.catalog, ctx.productId)?.dailyPrice,
        }
      }
      const action = nextActionToAction(nextProfile)
      return action ?? fallthroughToModeFallback(ctx)
    },
  },
  {
    // 13. 兜底：合并分类器的 mode 决定 follow_flow / faq / small_talk / handoff
    name: 'llm-mode-fallback',
    when: () => true,
    act: (ctx) => fallthroughToModeFallback(ctx),
  },
]

/**
 * 规则 13 的实现（也被规则 10-12 的"deriveNextProfile 推不出动作"路径复用——
 * legacy 的 if 级联在 action 为空时自然落到底部分支，规则表用显式调用表达同一语义）。
 */
async function fallthroughToModeFallback(ctx: RuleContext): Promise<Action> {
  const decision = await ctx.decideMode()
  const productConfirmed = isProductConfirmed(ctx)

  if (decision.mode === 'handoff') {
    return {
      kind: 'handoff',
      reason: decision.handoffReason || '需人工处理',
      text: '这个问题我帮您转一下店长跟进，稍等一下。',
    }
  }
  if (decision.mode === 'small_talk') {
    const text = (decision.smallTalkText || '好嘞').trim().slice(0, 40)
    return { kind: 'small_talk', text }
  }
  if (decision.mode === 'answer_faq') {
    const text = (decision.faqAnswer || '').trim()
    // 未确认款式时，answer_faq 的 followUp 不能是档期/身高体重的追问，
    // 必须把用户拉回"选款"环节
    if (!productConfirmed) {
      return {
        kind: 'answer_faq',
        text: text || '这边需要再帮您确认一下，稍等。',
        orchestrationFollowUp: '您先把中意的款式或商品编号发我，我帮您对一下。',
      }
    }
    const nextProfile = deriveNextProfile(ctx)
    const follow = nextActionToAction(nextProfile)
    const followUp = follow ? previewFollowPrompt(follow) : undefined
    return {
      kind: 'answer_faq',
      text: text || '这边需要再帮您确认一下，稍等。',
      orchestrationFollowUp: followUp,
    }
  }
  // mode === 'follow_flow'
  // 未确认款式时，follow_flow 绝不能推到 ask_period/ask_body/confirm_size；
  // 必须先把客户拉回选款环节
  if (!productConfirmed) {
    return { kind: 'ask_product' }
  }
  const nextProfile = deriveNextProfile(ctx)
  const action = nextActionToAction(nextProfile)
  return action ?? { kind: 'ask_product' }
}

/** selectAction 的返回：命中的 Action + 规则名（trace/调试可观测） */
export interface SelectedAction {
  action: Action
  ruleName: string
}

/** 按规则表顺序取第一条命中的规则并执行。最后一条 when 恒真，必有产出。 */
export async function selectAction(ctx: RuleContext): Promise<SelectedAction> {
  for (const rule of RULES) {
    if (rule.when(ctx)) {
      return { action: await rule.act(ctx), ruleName: rule.name }
    }
  }
  // 不可达（llm-mode-fallback 恒真），类型上兜底
  return { action: { kind: 'ask_product' }, ruleName: 'unreachable-default' }
}
