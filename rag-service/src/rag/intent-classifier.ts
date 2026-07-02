// 用户意图分类器（独立一层）：
//   fast-path：关键词高置信度直接返回（"在吗"/"好的"这种没必要花一次 LLM）
//   main：调 LLM tool-call，一次性输出 intent 枚举
//   fallback：LLM 出错 → 再走一次更宽松的关键词匹配
//
// 下游所有模块（memory-store fact extractor、action-picker 决策）都从这里拿 intent，
// 不再各自写一套关键词规则。

import { config } from '../config.js'
import { openai } from '../openai.js'
import type {
  ConversationProfile,
  IntentClassification,
  MemoryMessage,
  UserIntent,
} from '../types.js'

const FAST_PATH_RULES: Array<{
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

// 兜底关键词匹配：用于 LLM 失败时粗分类
function classifyByKeywords(question: string, hasContext: boolean): IntentClassification {
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
    /(?:黑|白|蓝|灰|红|粉|紫|绿|金|银|棕|卡其|米|驼)色|双排扣|单排扣|三件套|两件套|燕尾|礼服|旗袍|晚礼|婚纱|SUIT[-_ ]?\d+|想租|要租|想要|看中/.test(
      q,
    )
  ) {
    return { intent: 'select_product', confidence: 'medium', source: 'keyword' }
  }
  return { intent: hasContext ? 'other' : 'small_talk', confidence: 'low', source: 'keyword' }
}

function buildContextLine(
  profile?: ConversationProfile,
  recentMessages?: MemoryMessage[],
  lastAssistantMessage?: string,
): string {
  const parts: string[] = []
  if (profile?.productIntent?.currentProductText)
    parts.push(`已锁定商品: ${profile.productIntent.currentProductText}`)
  if (profile?.rentalPeriod?.startDate)
    parts.push(
      `已有档期: ${profile.rentalPeriod.startDate} ~ ${profile.rentalPeriod.endDate ?? '?'}`,
    )
  if (profile?.heightCm || profile?.weightKg)
    parts.push(`已有体型: ${profile.heightCm ?? '?'}cm / ${profile.weightKg ?? '?'}kg`)
  if (profile?.orchestration?.stage) parts.push(`当前阶段: ${profile.orchestration.stage}`)
  if (lastAssistantMessage) parts.push(`上一条客服: ${lastAssistantMessage.slice(0, 80)}`)
  const history = (recentMessages ?? [])
    .slice(-4)
    .map((m) => `${m.role === 'user' ? '客户' : '客服'}: ${m.content.slice(0, 60)}`)
    .join('\n')
  return parts.join('\n') + (history ? `\n---\n${history}` : '')
}

const SYSTEM_PROMPT = `你是客服对话意图分类器。给你"用户这一句话 + 最近几轮上下文"，选 1 个最匹配的意图。只调用 classify_intent 工具。

10 个意图类别：
- select_product: 用户在**选择或切换具体商品**（提到具体颜色+款式/商品编号/具体款式名，或"想租/要租某某"）。示例："想租黑色双排扣西装"、"要那件 SUIT-001"、"换成三件套"
- provide_period: **提供租赁日期**。示例："5月10到12号"、"租 3 天"、"下周五用"
- provide_body: **提供身高/体重/三围**。示例："174cm 75kg"、"身高 180"
- confirm: **对上一条的简短肯定**。示例："好的"、"对的"、"没错"、"就这样"、"可以"
- ask_info: **询问信息**——图片/图/样图/尺码表/价目表/链接/物流/多少钱/政策/是否包邮等。示例："发我所有款式的图片"、"尺码表看一下"、"多少钱"、"几天能到"
- place_order: **询问或表达下单意图**。示例："怎么下单"、"我要下单"、"在哪买"
- small_talk: 打招呼/感谢/emoji/废话。示例："在吗"、"谢谢"、"嗯嗯"
- request_handoff: 要人工/投诉/强烈不满。示例："转人工"、"我要投诉"
- update_correction: **修改之前给的信息**。示例："改成 5 月 15 号"、"不是 L 是 M"
- other: 兜底，无法归入上述任何一类

判断原则：
1. "请求信息" vs "选择商品" 的边界：如果用户只是想让你发图/样图/尺码表/链接等，哪怕句子里出现"款式"，都是 ask_info，不是 select_product
2. "下单" vs "选款"：只说"我要买/我要下单"没指定款式 = place_order；指定了款式 = select_product
3. 一句话可能包含多种信息（如"黑色西装 5月10号用"），选"最主要的新增信息"——有具体款式优先 select_product
4. 只输出 1 个 intent，即使有歧义也必须选 1 个`

export async function classifyUserIntent(input: {
  question: string
  profile?: ConversationProfile
  recentMessages?: MemoryMessage[]
  lastAssistantMessage?: string
}): Promise<IntentClassification> {
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

  // === 主路径：LLM tool-call ===
  try {
    const contextLine = buildContextLine(
      input.profile,
      input.recentMessages,
      input.lastAssistantMessage,
    )
    const userContent = `用户这一句：\n${question}\n\n上下文：\n${contextLine || '（空）'}`
    const completion = await openai.chat.completions.create({
      model: config.chatModel,
      temperature: 0,
      max_tokens: 120,
      tools: [
        {
          type: 'function',
          function: {
            name: 'classify_intent',
            description: '把用户这一句话分类成 1 个意图',
            parameters: {
              type: 'object',
              properties: {
                intent: {
                  type: 'string',
                  enum: [
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
                  ],
                  description: '10 选 1 的意图分类',
                },
                reason: {
                  type: 'string',
                  description: '一句话解释为什么选这个（30 字以内，便于 debug）',
                },
              },
              required: ['intent'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'classify_intent' } },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    })

    const call = completion.choices[0]?.message?.tool_calls?.[0]
    if (call?.function.name !== 'classify_intent') {
      return classifyByKeywords(question, !!input.profile)
    }
    const parsed = JSON.parse(call.function.arguments) as { intent?: UserIntent; reason?: string }
    const intent = parsed.intent
    if (
      intent === 'select_product' ||
      intent === 'provide_period' ||
      intent === 'provide_body' ||
      intent === 'confirm' ||
      intent === 'ask_info' ||
      intent === 'place_order' ||
      intent === 'small_talk' ||
      intent === 'request_handoff' ||
      intent === 'update_correction' ||
      intent === 'other'
    ) {
      return { intent, confidence: 'high', source: 'llm', reason: parsed.reason }
    }
    return classifyByKeywords(question, !!input.profile)
  } catch (error) {
    console.warn(
      '[intent-classifier] LLM 调用失败，回退关键词:',
      error instanceof Error ? error.message : String(error),
    )
    return classifyByKeywords(question, !!input.profile)
  }
}

/**
 * 把意图翻译成"这句话里允许抽取哪些字段"的开关，供下游使用。
 * 这样抽取器就不用再自己去看关键词——直接读 intent 决定要不要尝试抽取。
 */
export function intentToExtractionPolicy(intent: UserIntent) {
  switch (intent) {
    case 'select_product':
      return { allowProductIntent: true, allowPeriod: false, allowBody: false }
    case 'provide_period':
      return { allowProductIntent: false, allowPeriod: true, allowBody: false }
    case 'provide_body':
      return { allowProductIntent: false, allowPeriod: false, allowBody: true }
    case 'update_correction':
      // 修改类允许所有字段（用户可能同时改多个）
      return { allowProductIntent: true, allowPeriod: true, allowBody: true }
    case 'other':
      // 其他不知道的，保守允许全部（保留原有行为）
      return { allowProductIntent: true, allowPeriod: true, allowBody: true }
    case 'confirm':
    case 'ask_info':
    case 'place_order':
    case 'small_talk':
    case 'request_handoff':
    default:
      return { allowProductIntent: false, allowPeriod: false, allowBody: false }
  }
}
