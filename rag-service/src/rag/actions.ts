// 客服回复的所有可能动作。Action 是 discriminated union，每条消息最终只会落成一个 Action 实例，
// 然后由 templates.ts 中的 renderAction() 渲染成文本。
// 设计原则：LLM 只能"选 Action"，不能自由写文本（除了 answer_faq / small_talk 两个开放通道）。

export type Action =
  // ========== 快速路径（关键词 / 状态规则命中，不经 LLM） ==========
  | { kind: 'greet' }
  | { kind: 'repair'; hint?: string }
  | { kind: 'rental_howto'; productId?: string; dailyPrice?: number; renewalDailyPrice?: number; shippingPolicy?: string }
  | { kind: 'current_link_confirm'; productText?: string; productId?: string; dailyPrice?: number; renewalDailyPrice?: number }
  | { kind: 'recall_body_empty' }
  | { kind: 'recall_body_ambiguous'; labels: string[] }
  | { kind: 'post_order_delivery'; rentalStartDate?: string; needsHandoff: boolean; handoffReason?: string }
  | { kind: 'post_order_followup' }
  | { kind: 'quote_price'; dailyPrice?: number; renewalDailyPrice?: number; shippingPolicy?: string; nextPrompt?: string }

  // ========== 流程推进路径（orchestrator 决定，模板渲染） ==========
  | { kind: 'ask_product' }
  | { kind: 'ask_period'; productText?: string; missingBody?: boolean; missingQuantity?: boolean }
  | { kind: 'ask_body'; startDate?: string; endDate?: string; knownHeightCm?: number; knownWeightKg?: number; missingPeriod?: boolean; missingQuantity?: boolean }
  | { kind: 'confirm_body_anomaly'; heightCm?: number; weightKg?: number; suspicion: 'weight_too_high' | 'height_too_high' | 'height_too_low' }
  | { kind: 'ack_body_measurement'; isUpdating: boolean; heightCm?: number; weightKg?: number; inferredUnit?: 'kg' | 'jin' }
  | { kind: 'ack_rental_period'; isUpdating: boolean; startDate?: string; endDate?: string }
  | { kind: 'confirm_size'; size: string; note?: string }
  | { kind: 'confirm_review'; productText?: string; startDate?: string; endDate?: string; size?: string; quantity?: number; quantityIsDefault?: boolean }
  | { kind: 'guide_order'; size?: string; startDate?: string; endDate?: string; dailyPrice?: number; quantity?: number; quantityIsDefault?: boolean }
  | { kind: 'check_availability' }

  // ========== 开放通道（LLM 自由生成内容，但限定角色和长度） ==========
  // answer_faq: 回答事实性问题（商店名、电话、租赁规则等），内容来自 references
  | { kind: 'answer_faq'; text: string; orchestrationFollowUp?: string }
  // small_talk: 极短闲聊响应
  | { kind: 'small_talk'; text: string }
  // handoff: 需要人工介入
  | { kind: 'handoff'; text: string; reason: string };

export type ActionKind = Action['kind'];
