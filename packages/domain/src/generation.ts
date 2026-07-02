// 受限 LLM 生成 + 三层安全门 + 模板回退（Action → 自然语言文本的主路径）。
// 平移来源：rag-service/src/rag/generate-text.ts（prompt 组装与安全门逐字保真）。
// 与 templates.ts 的关系：templates.ts 是 deterministic fallback；这里是主路径。
// 端口调用失败 / 空产出 / 超硬性字符上限 / 禁用词命中 / spec 缺失 → 回退 renderAction(action)。
// answerSource（'llm' | 'fallback'）透出给上层观测回退率。
// 与 legacy 的差异：openai 直调改为 GeneratePort 注入（temperature/top_p 归适配器）；
// console.warn 有声降级改为 onFallback 回调注入（domain 不直接产生 IO）。

import {
  ACTION_SPECS,
  GLOBAL_FORBIDDEN_PATTERNS,
  SKIP_GENERATION_KINDS,
  type ActionSpec,
} from './action-specs.js'
import type { GeneratePort } from './ports.js'
import { renderAction } from './templates.js'
import type { Action, ConversationProfile, MemoryMessage } from './types.js'

/** legacy generate-text.ts 的 max_tokens: 260（生成一条微信消息绰绰有余） */
const GENERATION_MAX_TOKENS = 260

/** 生成上下文：拼 user prompt 所需的会话资料（RuleContext 的子集 + stylistPrompt） */
export interface GenerationContext {
  question: string
  productId?: string
  conversationProfile?: ConversationProfile
  effectiveProductText?: string
  recentMessages?: MemoryMessage[]
  /** 版本化 prompt 配置里的说话风格段（config/prompts/<v>.yaml 的 stylistPrompt） */
  stylistPrompt: string
}

/** 回退原因（onFallback 观测用） */
export type GenerationFallbackReason =
  | 'skip-generation-kind'
  | 'missing-spec'
  | 'empty-output'
  | 'too-long'
  | 'forbidden-pattern'
  | 'port-error'

export interface GeneratedReply {
  text: string
  source: 'llm' | 'fallback'
}

/** 组装 Action-scoped system prompt：风格 + 本轮目标 + 硬规则 + 长度限制 + 好坏示例 + 通用禁令 */
function buildSystemPrompt(spec: ActionSpec, stylistPrompt: string): string {
  const lines: string[] = [
    '你是一家服装租赁门店的真实客服店员（真人，不是 AI），正在用微信和客户聊天。',
    '',
    '## 说话风格',
    stylistPrompt,
    '',
    '## 本轮目标',
    spec.goal,
    '',
    '## 硬规则（违反会被拦截，直接失败）',
    ...spec.hardRules.map((r, i) => `${i + 1}. ${r}`),
    '',
    '## 长度限制',
    `不超过 ${spec.maxSentences} 句，字符数 ≤ ${spec.maxChars}。`,
    '不使用 Markdown、编号列表、项目符号、换行。',
    '',
  ]

  if (spec.goodExamples && spec.goodExamples.length > 0) {
    lines.push('## 好的示例（可以按这种风格写）')
    for (const ex of spec.goodExamples) lines.push(`- "${ex}"`)
    lines.push('')
  }
  if (spec.badExamples && spec.badExamples.length > 0) {
    lines.push('## 坏的示例（绝对不要这样写）')
    for (const ex of spec.badExamples) lines.push(`- "${ex}"`)
    lines.push('')
  }

  lines.push(
    '## 通用禁令',
    '- 绝对不问胸围/腰围/肩宽/三围/常穿码/几 XL/M/L/尺码号/48/50/软尺',
    '- 绝对不问"整套还是两件套"',
    '- 绝对不自称 AI/机器人/智能助手/大语言模型',
    '- 不罗列商品类目（西装/礼服/衬衫之类让客户自己说）',
    '',
    '只输出要发给客户的那一段纯文本，不要前缀、不要"店员："、不要解释。',
  )
  return lines.join('\n')
}

/** Action 实例 → 逐字段的任务描述文本 */
function formatAction(action: Action): string {
  const lines: string[] = [`Action: ${action.kind}`]
  for (const [key, value] of Object.entries(action)) {
    if (key === 'kind') continue
    if (value === undefined || value === null || value === '') continue
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  return lines.join('\n')
}

/** 已知会话资料 → 上下文行（商品/体型/档期/尺码/价格/订单号） */
function formatProfile(ctx: GenerationContext): string {
  const profile = ctx.conversationProfile
  const lines: string[] = []
  if (ctx.effectiveProductText) lines.push(`商品：${ctx.effectiveProductText}`)
  else if (ctx.productId) lines.push(`商品ID：${ctx.productId}`)

  if (profile?.heightCm !== undefined) lines.push(`身高：${profile.heightCm}cm`)
  if (profile?.weightKg !== undefined) lines.push(`体重：${profile.weightKg}kg`)

  if (profile?.rentalPeriod?.startDate) {
    const r = profile.rentalPeriod
    lines.push(
      `档期：${r.startDate}${r.endDate && r.endDate !== r.startDate ? ` 到 ${r.endDate}` : ''}`,
    )
  }

  if (profile?.sizeRecommendation?.recommendedSize) {
    lines.push(`推荐尺码：${profile.sizeRecommendation.recommendedSize}`)
  }
  if (profile?.priceQuote?.dailyPrice !== undefined) {
    lines.push(
      `首日价：${profile.priceQuote.dailyPrice}元 / 续租每日：${profile.priceQuote.renewalDailyPrice ?? '?'}元`,
    )
  }
  if (profile?.orderPlacement?.orderNo) lines.push(`订单号：${profile.orderPlacement.orderNo}`)

  return lines.length > 0 ? lines.join('\n') : '（尚无）'
}

/** 最近几轮对话 → 客户/店员台词行（最多 6 条） */
function formatRecent(recent?: MemoryMessage[]): string {
  if (!recent || recent.length === 0) return '（没有历史对话）'
  return recent
    .slice(-6)
    .map((m) => `${m.role === 'user' ? '客户' : '店员'}：${m.content}`)
    .join('\n')
}

/** 组装 user prompt：最近对话 + 已知资料 + 客户本轮消息 + Action 任务描述 */
function buildUserPrompt(action: Action, ctx: GenerationContext): string {
  return [
    '=== 最近几轮对话 ===',
    formatRecent(ctx.recentMessages),
    '',
    '=== 当前已知资料 ===',
    formatProfile(ctx),
    '',
    '=== 客户本轮刚发 ===',
    ctx.question,
    '',
    '=== 你要做的事（详细） ===',
    formatAction(action),
    '',
    '请用店员口吻发一条自然的微信消息给客户。',
  ].join('\n')
}

/**
 * 受限生成主入口。安全三层：
 *   Action 选择（routing 代码） → Action 专属硬规则（spec prompt） →
 *   生成后校验（硬性字符上限 + GLOBAL_FORBIDDEN_PATTERNS）。
 * 任一环节不满足即回退 renderAction 模板并标记 source='fallback'。
 */
export async function generateReplyText(
  port: GeneratePort,
  action: Action,
  ctx: GenerationContext,
  onFallback?: (reason: GenerationFallbackReason, detail?: string) => void,
): Promise<GeneratedReply> {
  // 已经由上游生成过文本（分类器 / 固定话术）
  if (SKIP_GENERATION_KINDS.has(action.kind)) {
    onFallback?.('skip-generation-kind')
    return { text: renderAction(action), source: 'fallback' }
  }

  const spec = ACTION_SPECS[action.kind]
  if (!spec) {
    onFallback?.('missing-spec')
    return { text: renderAction(action), source: 'fallback' }
  }

  try {
    const raw = (
      await port.generate({
        system: buildSystemPrompt(spec, ctx.stylistPrompt),
        user: buildUserPrompt(action, ctx),
        maxTokens: GENERATION_MAX_TOKENS,
      })
    )?.trim()

    if (!raw) {
      onFallback?.('empty-output')
      return { text: renderAction(action), source: 'fallback' }
    }

    // 1. 硬性字符上限——超长直接 fallback（LLM 对"10 字以内"这种指令遵守度低）
    if (raw.length > spec.maxChars) {
      onFallback?.('too-long', `action=${action.kind} length=${raw.length} > ${spec.maxChars}`)
      return { text: renderAction(action), source: 'fallback' }
    }

    // 2. 禁用词校验——命中就 fallback
    for (const pattern of GLOBAL_FORBIDDEN_PATTERNS) {
      if (pattern.test(raw)) {
        onFallback?.('forbidden-pattern', `action=${action.kind} pattern=${pattern.source}`)
        return { text: renderAction(action), source: 'fallback' }
      }
    }

    return { text: raw, source: 'llm' }
  } catch (error) {
    onFallback?.('port-error', error instanceof Error ? error.message : String(error))
    return { text: renderAction(action), source: 'fallback' }
  }
}
