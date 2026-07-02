// @rental/domain 领域类型层。
// 从 legacy rag-service/src/types.ts + rag-service/src/rag/actions.ts 平移合并而来，
// 字段名与 Action kind 值一字不改（金标 YAML 的结构断言依赖这些字面量）。
// 舍弃项（图片通道 / 知识管理后台随 RW-1 舍弃，见 docs/architecture.md §0.5）：
//   SourceType / ContentType / KnowledgeChunk / VectorPoint（Qdrant 与知识入库实现类型）、
//   ChatRequestBody（Fastify HTTP 层类型，含 imageUrl 图片通道字段）。
// 已 grep 确认金标 YAML 与 orchestrator / templates 均未引用上述被砍类型。

// ============ 用户意图分类器 ============
// 代替散落在 memory-store / action-picker 里的"这句话是不是确认/..."
// 这种零碎关键词判断，统一一个 enum + 一次 LLM 调用产出。
export type UserIntent =
  | 'select_product' // 想租黑色西装 / 换成 SUIT-001 / 要那件双排扣
  | 'provide_period' // 5月10到12号 / 租3天
  | 'provide_body' // 174cm 75kg / 我身高175
  | 'confirm' // 好的 / 对的 / 没错 / 就这样
  | 'ask_info' // 尺码表 / 价格多少 / 怎么租
  | 'place_order' // 怎么下单 / 我下单
  | 'small_talk' // 在吗 / 你好 / 谢谢 / emoji
  | 'request_handoff' // 投诉 / 转人工 / 要店长
  | 'update_correction' // 改成 5月15 / 不是L是M / 错了
  | 'other' // 兜底

export interface IntentClassification {
  intent: UserIntent
  confidence: 'high' | 'medium' | 'low'
  source: 'keyword' | 'llm' | 'fallback'
  reason?: string
}

// 回复模式（4 类）。legacy action-picker.ts 的 decide_reply 枚举原样保留；
// §8.2 合并分类器后与 UserIntent 由同一次 ClassifyPort 调用产出。
export type ReplyMode = 'follow_flow' | 'answer_faq' | 'small_talk' | 'handoff'

export interface BodyProfile {
  profileId: string
  label: string
  heightCm?: number
  weightKg?: number
  source: 'message' | 'sessionContext' | 'manual'
  lastMentionedAt: string
  notes?: string
}

export interface RentalPeriod {
  startDate?: string
  endDate?: string
  source: 'message' | 'sessionContext' | 'manual'
  lastMentionedAt: string
}

export interface ProductIntent {
  currentProductText?: string
  source: 'message' | 'sessionContext' | 'manual'
  lastMentionedAt: string
}

export interface PriceQuote {
  dailyPrice?: number
  renewalDailyPrice?: number
  currency?: string
  shippingPolicy?: string
  pricingNote?: string
  source: 'knowledge' | 'sessionContext' | 'manual'
  lastQuotedAt: string
}

export interface SizeRecommendation {
  recommendedSize?: string
  confidence?: 'low' | 'medium' | 'high'
  missingFields?: string[]
  source: 'knowledge' | 'manual' | 'rule'
  lastRecommendedAt: string
}

export interface AvailabilityCheck {
  hasSize?: boolean
  hasInventory?: boolean
  hasSchedule?: boolean
  availableSize?: string
  productId?: string
  rentalStartDate?: string
  rentalEndDate?: string
  source: 'knowledge' | 'manual' | 'api'
  checkedAt: string
}

export interface ReviewCheck {
  needed: boolean
  completed: boolean
  passed: boolean
  reviewedAt?: string
  source: 'system' | 'manual'
  summary?: string
  failureReason?: string
}

export interface AvailabilityQueryInput {
  productId: string
  heightCm: number
  weightKg: number
  rentalStartDate: string
  rentalEndDate: string
}

export interface Review {
  score: number // 1-10，评估失败为 0
  issues: string[]
  suggestions: string[]
  suggestedReply?: string // LLM 给出的"理想回复"建议
  timestamp: string
  source: 'system' | 'user'
  evaluatedReply?: string
  promptVersion?: string // 发生评估时的 prompt 版本哈希
  chatModel?: string // 生成该客服回复时使用的对话模型
  evaluatorModel?: string // 执行评估的模型
  error?: string // 评估失败时的错误摘要
}

export interface AvailabilityQueryResult {
  available: boolean
  availableSize?: string
  checkedAt: string
  source: 'api'
}

export interface OrderReadiness {
  needProductId: boolean
  needRentalPeriod: boolean
  needHeightWeight: boolean
  needSizeRecommendation: boolean
  needAvailabilityCheck: boolean
  needReviewCheck?: boolean
  // 数量默认 1，所以不会作为下单 blocker；这里记录"用户是否显式指定过"
  // 仅用于 follow-up 文案，不参与 readyToOrder 判定
  needQuantity?: boolean
  readyToOrder: boolean
  nextStep?: string
  updatedAt: string
}

export interface QuantityInfo {
  count: number // 件数，未显式给出时按默认 1 处理
  isExplicit: boolean // 是否客户主动给出过（false 表示走默认值）
  source: 'message' | 'sessionContext' | 'manual' | 'default'
  lastMentionedAt: string
}

export interface OrderPlacement {
  orderNo: string
  placedAt: string
  source: 'manual'
}

export interface HandoffStatus {
  needed: boolean
  reason?: string
  createdAt: string
  source: 'system' | 'manual'
}

export type ConversationStage =
  | 'intent_discovery'
  | 'product_locking'
  | 'schedule_collecting'
  | 'body_collecting'
  | 'size_confirming'
  | 'availability_checking'
  | 'review_confirming'
  | 'order_guiding'
  | 'post_order_followup'

// docs/architecture.md §4 端口接口使用的简称，与 ConversationStage 同一词汇表
export type Stage = ConversationStage

export type NextActionType =
  | 'ask_product'
  | 'ask_rental_period'
  | 'ask_body_measurements'
  | 'confirm_size'
  | 'check_availability'
  | 'confirm_review'
  | 'guide_order'
  | 'answer_question'
  | 'close_loop'

export interface ConversationOrchestration {
  stage: ConversationStage
  currentGoal: string
  pendingSlots: string[]
  completedSlots: string[]
  blockingIssues: string[]
  nextAction: NextActionType
  followUpQuestion?: string
  proactiveFollowUpCount?: number
  proactiveFollowUpLimit?: number
  lastProactiveFollowUpAt?: string
  waitingForUser?: boolean
  paused?: boolean
  replyTemplateKey?: string
  shouldUseRag: boolean
  shouldUseBusinessTools: boolean
  handoffNeeded: boolean
  handoffReason?: string
  updatedAt: string
}

export interface ConversationProfile {
  heightCm?: number
  weightKg?: number
  rentalPeriod?: RentalPeriod
  productIntent?: ProductIntent
  quantity?: QuantityInfo
  priceQuote?: PriceQuote
  sizeRecommendation?: SizeRecommendation
  availabilityCheck?: AvailabilityCheck
  reviewCheck?: ReviewCheck
  orderReadiness?: OrderReadiness
  orderPlacement?: OrderPlacement
  handoffStatus?: HandoffStatus
  orchestration?: ConversationOrchestration
  updatedAt: string
}

export interface MemoryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  intent?: UserIntent // 仅用户消息有，记录这一轮分类器的 tag，方便回放/审计
}

export interface ProductMemory {
  productId: string
  conversationId: string
  summary: string
  recentMessages: MemoryMessage[]
  conversationProfile: ConversationProfile
  reviews: Review[]
  updatedAt: string
}

export interface CustomerMemory {
  customerId: string
  globalSummary: string
  sessionContext: Record<string, string | number | boolean | null>
  bodyProfiles: BodyProfile[]
  productMemories: Record<string, ProductMemory>
  overallRating?: number
  totalReviews: number
  updatedAt: string
}

// ============ Action：客服回复的所有可能动作 ============
// 从 legacy rag-service/src/rag/actions.ts 原样合入。Action 是 discriminated union，
// 每条消息最终只会落成一个 Action 实例，然后由 templates.ts 中的 renderAction() 渲染成文本。
// 设计原则：LLM 只能"选 Action"，不能自由写文本（除了 answer_faq / small_talk 两个开放通道）。

export type Action =
  // ========== 快速路径（关键词 / 状态规则命中，不经 LLM） ==========
  | { kind: 'greet' }
  | { kind: 'repair'; hint?: string; escalate?: boolean }
  | {
      kind: 'rental_howto'
      productId?: string
      dailyPrice?: number
      renewalDailyPrice?: number
      shippingPolicy?: string
    }
  | {
      kind: 'current_link_confirm'
      productText?: string
      productId?: string
      dailyPrice?: number
      renewalDailyPrice?: number
    }
  | { kind: 'recall_body_empty' }
  | { kind: 'recall_body_ambiguous'; labels: string[] }
  | {
      kind: 'post_order_delivery'
      rentalStartDate?: string
      needsHandoff: boolean
      handoffReason?: string
    }
  | { kind: 'post_order_followup' }
  | {
      kind: 'quote_price'
      dailyPrice?: number
      renewalDailyPrice?: number
      shippingPolicy?: string
      nextPrompt?: string
    }

  // ========== 流程推进路径（orchestrator 决定，模板渲染） ==========
  | { kind: 'ask_product' }
  | { kind: 'ask_period'; productText?: string; missingBody?: boolean; missingQuantity?: boolean }
  | {
      kind: 'ask_body'
      startDate?: string
      endDate?: string
      knownHeightCm?: number
      knownWeightKg?: number
      missingPeriod?: boolean
      missingQuantity?: boolean
    }
  | {
      kind: 'confirm_body_anomaly'
      heightCm?: number
      weightKg?: number
      suspicion: 'weight_too_high' | 'height_too_high' | 'height_too_low'
    }
  | {
      kind: 'ack_body_measurement'
      isUpdating: boolean
      heightCm?: number
      weightKg?: number
      inferredUnit?: 'kg' | 'jin'
    }
  | { kind: 'ack_rental_period'; isUpdating: boolean; startDate?: string; endDate?: string }
  | { kind: 'confirm_size'; size: string; note?: string }
  | {
      kind: 'confirm_review'
      productText?: string
      startDate?: string
      endDate?: string
      size?: string
      quantity?: number
      quantityIsDefault?: boolean
    }
  | {
      kind: 'guide_order'
      size?: string
      startDate?: string
      endDate?: string
      dailyPrice?: number
      quantity?: number
      quantityIsDefault?: boolean
    }
  | { kind: 'check_availability' }

  // ========== 开放通道（LLM 自由生成内容，但限定角色和长度） ==========
  // answer_faq: 回答事实性问题（商店名、电话、租赁规则等），内容来自 references
  | { kind: 'answer_faq'; text: string; orchestrationFollowUp?: string }
  // small_talk: 极短闲聊响应
  | { kind: 'small_talk'; text: string }
  // handoff: 需要人工介入
  | { kind: 'handoff'; text: string; reason: string }

export type ActionKind = Action['kind']
