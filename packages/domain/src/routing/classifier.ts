// §8.2 合并分类器：legacy 的两个 LLM 分类调用（intent-classifier.ts 的 classify_intent
// 10 类 + action-picker.ts 的 decide_reply 4 类）合并为一次 ClassifyPort 调用，
// 同时返回 {intent, mode}，每轮 LLM 调用 -1，语义不变：
//   - 关键词 fast-path 在 domain 侧（FAST_PATH_RULES 命中时依旧零 LLM 调用）；
//   - 端口只在模糊时被调用，且整轮至多一次（memoized）；
//   - tool_choice 强制属于适配器职责；domain 负责解析端的枚举白名单校验与
//     非法值/抛错的保守回退（intent → 关键词粗分类，mode → follow_flow）。
// 平移来源：rag-service/src/rag/intent-classifier.ts L18-119（fast-path 与关键词兜底逐字保真）。

import type { ClassifyPort, ClassifyPortInput, KnowledgeHit } from '../ports.js'
import type {
  ConversationProfile,
  IntentClassification,
  MemoryMessage,
  ReplyMode,
  UserIntent,
} from '../types.js'

// ============ 关键词 fast-path（高置信度直接返回，不打 LLM） ============

export const FAST_PATH_RULES: Array<{
  intent: UserIntent
  pattern: RegExp
  confidence: 'high' | 'medium'
}> = [
  // 高置信度关键词：一眼就能确定的短句，不浪费 LLM
  {
    intent: 'small_talk',
    pattern:
      /^(?:在[吗么]?|您?好|你好|哈喽|hi|hello|hey|嗨|早|晚上好|早上好|中午好)[\s!?？。！~～]*$/i,
    confidence: 'high',
  },
  {
    intent: 'small_talk',
    pattern: /^(?:谢谢|感谢|辛苦[了啦]?|多谢|thanks|thx|麻烦了)[\s!?？。！~～]*$/i,
    confidence: 'high',
  },
  {
    intent: 'confirm',
    pattern:
      /^(?:是|是的|对|对的|嗯|嗯嗯|好的|好|行|可以|没错|没问题|就这样|ok|OK)[\s!?？。！~～]*$/,
    confidence: 'high',
  },
  {
    intent: 'request_handoff',
    pattern: /(?:要投诉|转人工|找人工|找店长|找经理|找客服|人工服务|需要人工)/,
    confidence: 'high',
  },
]

/** 兜底关键词匹配：用于 LLM 失败/返回非法值时的粗分类 */
export function classifyByKeywords(question: string, hasContext: boolean): IntentClassification {
  const q = question.replace(/\s+/g, '').trim()
  for (const rule of FAST_PATH_RULES) {
    if (rule.pattern.test(q)) {
      return { intent: rule.intent, confidence: rule.confidence, source: 'keyword' }
    }
  }
  if (/投诉|退款|赔偿|起诉|差评/.test(q)) {
    return { intent: 'request_handoff', confidence: 'medium', source: 'keyword' }
  }
  if (
    /图片|照片|样图|款式图|尺码表|价目表|价格表|链接|网址|看[下看]?一?下|多少钱|什么价|物流|包邮|几天到|退换|换货/.test(
      q,
    )
  ) {
    return { intent: 'ask_info', confidence: 'medium', source: 'keyword' }
  }
  if (/下单|怎么买|在哪买|怎么订|怎么租|先下单|付款|支付/.test(q) && !/怎么算|怎么发/.test(q)) {
    return { intent: 'place_order', confidence: 'medium', source: 'keyword' }
  }
  if (/[0-9]+\s*(?:cm|公分|厘米|kg|斤|公斤)|身高\s*[0-9]|体重\s*[0-9]|三围/.test(q)) {
    return { intent: 'provide_body', confidence: 'medium', source: 'keyword' }
  }
  if (
    /[0-9]+月[0-9]+[日号]|[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|租[一二三四五六七八九十]?[0-9]?[几多]?天|档期|租赁时间|时间是|[0-9]+月|明[天日]|后[天日]|大后天|下周|下下周/.test(
      q,
    )
  ) {
    return { intent: 'provide_period', confidence: 'medium', source: 'keyword' }
  }
  if (/改成|改为|改到|不是.*是|修正|搞错|写错|应该是|其实是/.test(q)) {
    return { intent: 'update_correction', confidence: 'medium', source: 'keyword' }
  }
  if (
    /(?:黑|白|蓝|灰|红|粉|紫|绿|金|银|棕|卡其|米|驼)色|双排扣|单排扣|三件套|两件套|燕尾|礼服|旗袍|婚纱|SUIT[-_ ]?\d+|想租|要租|想要|看中/.test(
      q,
    )
  ) {
    return { intent: 'select_product', confidence: 'medium', source: 'keyword' }
  }
  return { intent: hasContext ? 'other' : 'small_talk', confidence: 'low', source: 'keyword' }
}

// ============ 枚举白名单 ============

const INTENT_WHITELIST: readonly UserIntent[] = [
  'select_product',
  'provide_period',
  'provide_body',
  'confirm',
  'ask_info',
  'place_order',
  'small_talk',
  'request_handoff',
  'update_correction',
  'other',
]

const MODE_WHITELIST: readonly ReplyMode[] = ['follow_flow', 'answer_faq', 'small_talk', 'handoff']

/** intent 枚举白名单收窄；非法值返回 undefined（调用方走关键词回退） */
function asValidIntent(value: unknown): UserIntent | undefined {
  return typeof value === 'string' && (INTENT_WHITELIST as readonly string[]).includes(value)
    ? (value as UserIntent)
    : undefined
}

/** mode 枚举白名单收窄；非法值返回 undefined（调用方回退 follow_flow） */
function asValidMode(value: unknown): ReplyMode | undefined {
  return typeof value === 'string' && (MODE_WHITELIST as readonly string[]).includes(value)
    ? (value as ReplyMode)
    : undefined
}

// ============ 每轮分类器（memoized 单次端口调用） ============

/** 回复模式判定结果（decide_reply 的返回负载 + 来源标记） */
export interface ReplyModeDecision {
  mode: ReplyMode
  faqAnswer?: string
  smallTalkText?: string
  handoffReason?: string
  source: 'llm' | 'fallback'
}

/** 创建分类器时的固定上下文（引擎在 ① 记忆快照后就能提供的部分） */
export interface TurnClassifierInput {
  question: string
  profile?: ConversationProfile
  recentMessages?: MemoryMessage[]
  lastAssistantMessage?: string
}

/** decideMode 时补充的晚到上下文（检索命中/生效商品文本在 ③④⑤ 之后才有） */
export interface ModeContext {
  references?: KnowledgeHit[]
  productText?: string
}

export interface TurnClassifier {
  /** 意图分类：fast-path 命中零 LLM；否则触发（或复用）本轮唯一一次端口调用 */
  classifyIntent(): Promise<IntentClassification>
  /** 回复模式判定：复用（或触发）同一次端口调用；失败保守回退 follow_flow */
  decideMode(extra?: ModeContext): Promise<ReplyModeDecision>
}

/**
 * 构造一轮对话的合并分类器。端口调用严格 memoized：
 * - classifyIntent 先走关键词 fast-path，模糊才调端口；
 * - decideMode 需要 LLM 判定，若 intent 已触发过调用则直接复用其结果；
 *   若 intent 走了 fast-path，则由 decideMode 首次触发（此时可带上更全的
 *   references/productText 上下文——与 legacy decide_reply 的调用时机一致）。
 */
export function createTurnClassifier(
  port: ClassifyPort,
  input: TurnClassifierInput,
): TurnClassifier {
  let pendingCall: Promise<import('../ports.js').ClassifyPortResult> | undefined

  /** 触发（或复用）本轮唯一一次端口调用 */
  function callPortOnce(extra?: ModeContext) {
    if (!pendingCall) {
      const portInput: ClassifyPortInput = {
        question: input.question,
        stage: input.profile?.orchestration?.stage,
        profile: input.profile,
        recentMessages: input.recentMessages,
        lastAssistantMessage: input.lastAssistantMessage,
        productText: extra?.productText ?? input.profile?.productIntent?.currentProductText,
        references: extra?.references,
      }
      pendingCall = port.classify(portInput)
    }
    return pendingCall
  }

  return {
    async classifyIntent() {
      const question = (input.question ?? '').trim()
      if (!question) {
        return { intent: 'small_talk', confidence: 'high', source: 'fallback' }
      }

      // === Fast path：关键词高置信度命中直接返回，不打 LLM ===
      const q = question.replace(/\s+/g, '')
      for (const rule of FAST_PATH_RULES) {
        if (rule.pattern.test(q)) {
          return { intent: rule.intent, confidence: rule.confidence, source: 'keyword' }
        }
      }

      // === 主路径：合并端口调用（同一结果里还带 mode，供 decideMode 复用） ===
      try {
        const result = await callPortOnce()
        const intent = asValidIntent(result.intent)
        if (intent) {
          return { intent, confidence: 'high', source: 'llm', reason: result.reason }
        }
        // 非法/缺失枚举 → 保守回退关键词
        return classifyByKeywords(question, !!input.profile)
      } catch {
        return classifyByKeywords(question, !!input.profile)
      }
    },

    async decideMode(extra) {
      try {
        const result = await callPortOnce(extra)
        const mode = asValidMode(result.mode)
        if (!mode) {
          // 非法/缺失枚举 → 保守回退 follow_flow（legacy callClassifier 解析失败同此）
          return { mode: 'follow_flow', source: 'fallback' }
        }
        return {
          mode,
          faqAnswer: result.faqAnswer,
          smallTalkText: result.smallTalkText,
          handoffReason: result.handoffReason,
          source: 'llm',
        }
      } catch {
        return { mode: 'follow_flow', source: 'fallback' }
      }
    },
  }
}
