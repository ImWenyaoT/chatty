// 事实抽取层：regex-first + LLM 端口兜底 + 意图门控写入策略。
// 平移来源（行为逐字保真）：
//   - intentToExtractionPolicy         ← rag-service/src/rag/intent-classifier.ts L242-264
//   - extractProvidedBody/Quantity     ← rag-service/src/rag.ts L26-39
//   - extractRentalPeriodFromText      ← rag-service/src/memory-store.ts L309-442
//     （rag.ts L42-86 的 extractProvidedPeriodFallback 与它是两份几乎相同的实现，
//       重写合并为这一份，以 memory-store 版为准——金标断言走的是记忆写入路径）
//   - normalizeSpecificProductText 等  ← rag-service/src/memory-store.ts L199-307
//   - extractTurnFacts（④⑤ 融合）      ← rag-service/src/rag.ts L242-295
// 与 legacy 的刻意差异（记录于完成报告）：融合后的档期（LLM 优先、regex 补缺）统一
// 喂给记忆路径；legacy 只在 LLM 抛错时才用 regex，离线 stub 场景下会丢档期。

import {
  buildCurrentMonthDate,
  buildCurrentYearMonthDate,
  coerceToIsoDate,
  coerceToIsoDateRange,
  normalizeDateText,
} from './parsers/date.js'
import { extractHeightWeightFromText, extractQuantityFromText } from './parsers/measurements.js'
import type { ExtractPort } from './ports.js'
import type { ConversationProfile, ProductIntent, RentalPeriod, UserIntent } from './types.js'

// ============ 意图 → 抽取门控策略 ============

export interface ExtractionPolicy {
  allowProductIntent: boolean
  allowPeriod: boolean
  allowBody: boolean
}

/**
 * 把意图翻译成"这句话里允许抽取哪些字段"的开关，供下游使用。
 * 这样抽取器就不用再自己去看关键词——直接读 intent 决定要不要尝试抽取。
 */
export function intentToExtractionPolicy(intent: UserIntent): ExtractionPolicy {
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
    default:
      // confirm / ask_info / place_order / small_talk / request_handoff
      return { allowProductIntent: false, allowPeriod: false, allowBody: false }
  }
}

// ============ 本轮消息的确定性抽取 ============

export interface ProvidedBody {
  heightCm?: number
  weightKg?: number
  isUpdating: boolean
  inferredUnit?: 'kg' | 'jin'
}

export interface ProvidedPeriod {
  startDate?: string
  endDate?: string
  isUpdating: boolean
}

export interface ProvidedQuantity {
  count: number
  isUpdating: boolean
}

/** 用户本轮的身高体重抽取（含"改成/更新"类措辞识别） */
export function extractProvidedBody(question: string): ProvidedBody | undefined {
  const { heightCm, weightKg, inferredWeightUnit } = extractHeightWeightFromText(question)
  if (heightCm === undefined && weightKg === undefined) return undefined
  const isUpdating = /修改|改下|改成|更新|重新记|重记|改一下/.test(question)
  return { heightCm, weightKg, isUpdating, inferredUnit: inferredWeightUnit }
}

/** 用户本轮的件数抽取（含"改成/调整"类措辞识别） */
export function extractProvidedQuantity(question: string): ProvidedQuantity | undefined {
  const count = extractQuantityFromText(question)
  if (count === undefined) return undefined
  const isUpdating = /改成|改为|改下|更新|调整|改一下|改回/.test(question)
  return { count, isUpdating }
}

/**
 * 正则档期抽取（全仓库唯一实现）。按优先级依次尝试：
 * 「改到 X 结束」→ 完整日期区间 → 显式开始/结束标签 → 跨月「5月9号到6月1号」→
 * 同月「5月9号到10号」→ 单日「5月9号」→ 纯日「9号到10号」→ 纯单日「9号」。
 * now 为 lastMentionedAt 时间戳（legacy 内联 new Date()，重写改注入以便测试）。
 */
export function extractRentalPeriodFromText(
  rawText: string,
  now: string,
): RentalPeriod | undefined {
  // 压掉所有空白后再处理，兼容 "5 月 10 号" 这种带空格的输入
  const text = rawText.replace(/\s+/g, '')
  const normalized = text
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/号/g, '')
    .trim()
  const datePattern = '([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2})'

  const updateEndMatch = normalized.match(
    new RegExp('(?:到|至|改到|改成|改为)?\\s*' + datePattern + '\\s*(?:结束|截止|归还|为止)', 'i'),
  )
  if (updateEndMatch) {
    return {
      endDate: normalizeDateText(updateEndMatch[1]),
      source: 'message',
      lastMentionedAt: now,
    }
  }

  const rangeMatch = normalized.match(
    new RegExp(datePattern + '\\s*(?:到|至|~|—|-|--|－)\\s*' + datePattern, 'i'),
  )
  if (rangeMatch) {
    return {
      startDate: normalizeDateText(rangeMatch[1]),
      endDate: normalizeDateText(rangeMatch[2]),
      source: 'message',
      lastMentionedAt: now,
    }
  }

  const startMatch = normalized.match(
    new RegExp(
      '(?:开始时间|租赁开始|租期开始|开始日期|起租时间|起始时间)[:： ]*' + datePattern,
      'i',
    ),
  )
  const endMatch = normalized.match(
    new RegExp(
      '(?:结束时间|租赁结束|租期结束|结束日期|归还时间|截止时间)[:： ]*' + datePattern,
      'i',
    ),
  )
  if (startMatch || endMatch) {
    return {
      startDate: startMatch ? normalizeDateText(startMatch[1]) : undefined,
      endDate: endMatch ? normalizeDateText(endMatch[1]) : undefined,
      source: 'message',
      lastMentionedAt: now,
    }
  }

  const monthDayRangeMatch = text.match(
    /([0-9]{1,2})月([0-9]{1,2})(?:日|号)?\s*(?:到|至|~|—|-|--|－)\s*([0-9]{1,2})月([0-9]{1,2})(?:日|号)?/i,
  )
  if (monthDayRangeMatch) {
    return {
      startDate: buildCurrentYearMonthDate(
        Number(monthDayRangeMatch[1]),
        Number(monthDayRangeMatch[2]),
      ),
      endDate: buildCurrentYearMonthDate(
        Number(monthDayRangeMatch[3]),
        Number(monthDayRangeMatch[4]),
      ),
      source: 'message',
      lastMentionedAt: now,
    }
  }

  // 同月跨日：「5月9号到10号」第二段省略月份，结束日沿用开始月份
  const sameMonthDayRangeMatch = text.match(
    /([0-9]{1,2})月([0-9]{1,2})(?:日|号)?\s*(?:到|至|~|—|-|--|－)\s*([0-9]{1,2})(?:日|号)?/i,
  )
  if (sameMonthDayRangeMatch) {
    const m = Number(sameMonthDayRangeMatch[1])
    const d1 = Number(sameMonthDayRangeMatch[2])
    const d2 = Number(sameMonthDayRangeMatch[3])
    if (d2 >= d1) {
      return {
        startDate: buildCurrentYearMonthDate(m, d1),
        endDate: buildCurrentYearMonthDate(m, d2),
        source: 'message',
        lastMentionedAt: now,
      }
    }
  }

  const monthDaySingleMatch = text.match(
    /([0-9]{1,2})月([0-9]{1,2})(?:日|号)?(?:用|穿|租|要用|需要|开始|当天)?/i,
  )
  if (monthDaySingleMatch) {
    const date = buildCurrentYearMonthDate(
      Number(monthDaySingleMatch[1]),
      Number(monthDaySingleMatch[2]),
    )
    return {
      startDate: date,
      endDate: date,
      source: 'message',
      lastMentionedAt: now,
    }
  }

  const dayOnlyRangeMatch = text.match(
    /([0-9]{1,2})(?:日|号)\s*(?:到|至|~|—|-|--|－)\s*([0-9]{1,2})(?:日|号)/i,
  )
  if (dayOnlyRangeMatch) {
    return {
      startDate: buildCurrentMonthDate(Number(dayOnlyRangeMatch[1])),
      endDate: buildCurrentMonthDate(Number(dayOnlyRangeMatch[2])),
      source: 'message',
      lastMentionedAt: now,
    }
  }

  const dayOnlySingleMatch = text.match(
    /(^|[^0-9])([0-9]{1,2})(?:日|号)(?:用|穿|租|要用|需要|开始|当天)?/i,
  )
  if (dayOnlySingleMatch) {
    const date = buildCurrentMonthDate(Number(dayOnlySingleMatch[2]))
    return {
      startDate: date,
      endDate: date,
      source: 'message',
      lastMentionedAt: now,
    }
  }

  return undefined
}

// ============ 商品意向的关键词守护与清洗 ============

/**
 * 判断用户这句话是不是在请求"信息/图片/尺码表/链接"类的东西——
 * 这类是"询问"而非"选款/换款"，不应让 productIntent 被更新（否则会把
 * "所有款式的图片"写进商品栏）。
 */
export function isInfoOrImageRequest(text: string): boolean {
  const q = text.replace(/\s+/g, '')
  // 图片/照片/链接/尺码表/价格表/样图 等信息请求
  if (
    /图片|图|照片|示意图|样图|样式图|款式图|尺码表|价格表|价目表|清单|列表|链接|网址|看[下看]?一?下/.test(
      q,
    )
  ) {
    // 不要误伤"图片"出现在商品名里的罕见情况——如果用户明确说"租"/"想要"某款，
    // 即便句子里有"图"字也应视为选款意图。通过"明显选款动词 + 具体实体"豁免。
    if (
      /(?:想租|要租|租下|选[定了]?|换成|改成).{0,10}(?:[黑白红蓝灰紫绿金银粉卡]色|双排扣|单排扣|三件套|两件套|燕尾|礼服|旗袍|SUIT[-_ ]?\d+|款)/.test(
        q,
      )
    ) {
      return false
    }
    return true
  }
  return false
}

/**
 * 判断一段文本是不是"具体到某个款/某件商品"。如果只是"租衣服""要套装"
 * 这种泛指动词+品类词，返回 undefined；否则返回清洗后的具体描述。
 */
export function normalizeSpecificProductText(text?: string | null): string | undefined {
  const raw = text?.trim()
  if (!raw) return undefined

  // 1) 剥离意图动词/指示词前缀：我想/想/要/想要/想租/要租/租/买/挑/看/找…
  //    以及后缀口语粘词
  const stripped = raw
    .replace(/^我?/, '')
    .replace(/^(?:想要|打算|准备|计划|要想|要|想)+/, '')
    .replace(/^(?:租|买|挑|选|找|搞|整|来|看)+/, '')
    .replace(/^(?:一|几)[件套个条]/, '')
    .replace(/[的啊呀吧呢嘛哇哦嗯][？。！?!.]*$/, '')
    .trim()
  const candidate = stripped || raw

  // 2) 完整命中泛指品类词，直接丢弃
  const GENERIC =
    /^(?:衣服|服装|服饰|衣物|西服|西装|礼服|款式|商品|东西|套装|外套|上衣|下装|裤子|裙子|大衣|毛衣|衬衫|男装|女装|童装|鞋子?|包|配饰|行头|搭配)$/i
  if (GENERIC.test(candidate)) return undefined

  // 3) 1-2 字纯中文基本都是泛指（具体款至少"黑西装""三件套"这种 3 字起）
  if (candidate.length <= 2 && /^[一-龥]+$/.test(candidate)) return undefined

  return candidate
}

/** 正则版商品意向抽取（LLM 端口不可用时的兜底路径） */
export function extractProductIntentFromText(text: string, now: string): ProductIntent | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (isInfoOrImageRequest(normalized)) {
    return undefined
  }
  if (
    /身高|体重|kg|斤|cm|厘米|档期|租赁时间|开始时间|结束时间|到\d{4}|至\d{4}|\d{4}-\d{1,2}-\d{1,2}/.test(
      normalized,
    )
  ) {
    return undefined
  }
  const match = normalized.match(
    /(?:想租|想看|想要|要租|换成|改成|想换成|意向商品|款式|衣服款式|商品)[:： ]*([^，。；;]+)/i,
  )
  if (!match) {
    return undefined
  }

  const raw = match[1]
    .trim()
    .replace(/[，。；;,.]+$/g, '')
    .trim()
  const currentProductText = normalizeSpecificProductText(raw)
  if (!currentProductText) return undefined

  return {
    currentProductText,
    source: 'message',
    lastMentionedAt: now,
  }
}

// ============ LLM 端口结果归一化 + 结构化事实抽取 ============

export interface StructuredFacts {
  rentalPeriod?: RentalPeriod
  productIntent?: ProductIntent
}

/**
 * 归一化 LLM 端口返回的 productIntent 形态：
 * 兼容简化字符串（"黑色西装"）与对象（{currentProductText}/{text}/{name}）。
 */
function normalizeRawProductIntent(p: unknown): { currentProductText: string } | null {
  if (!p) return null
  if (typeof p === 'string') {
    return p.trim() ? { currentProductText: p.trim() } : null
  }
  if (typeof p === 'object') {
    const obj = p as Record<string, unknown>
    const raw = obj.currentProductText ?? obj.text ?? obj.name
    return typeof raw === 'string' && raw.trim() ? { currentProductText: raw.trim() } : null
  }
  return null
}

/**
 * 归一化 LLM 端口返回的 rentalPeriod 形态：
 *   1) {startDate,endDate}  2) {start,end}  3) 字符串 "5月10日-5月12日"
 * 并把任何中文日期统一 normalize 成 "YYYY-M-D"。
 */
function normalizeRawRentalPeriod(
  r: unknown,
): { startDate: string | null; endDate: string | null } | null {
  if (!r) return null
  if (typeof r === 'string') {
    const { startDate, endDate } = coerceToIsoDateRange(r)
    if (!startDate && !endDate) return null
    return { startDate: startDate ?? null, endDate: endDate ?? null }
  }
  if (typeof r === 'object') {
    const obj = r as Record<string, unknown>
    const startRaw =
      (typeof obj.startDate === 'string' && obj.startDate) ||
      (typeof obj.start === 'string' && obj.start) ||
      null
    const endRaw =
      (typeof obj.endDate === 'string' && obj.endDate) ||
      (typeof obj.end === 'string' && obj.end) ||
      null
    const startDate = startRaw ? coerceToIsoDate(startRaw) : undefined
    const endDate = endRaw ? coerceToIsoDate(endRaw) : undefined
    if (!startDate && !endDate) return null
    return { startDate: startDate ?? null, endDate: endDate ?? null }
  }
  return null
}

/**
 * 结构化事实抽取：调 ExtractPort（LLM），成功则做形态归一化 + 意图门控；
 * 端口抛错则回退正则抽取（同样受门控）。平移 memory-store.ts 的
 * extractStructuredConversationFacts（L250-307）。
 */
export async function extractStructuredFacts(
  port: ExtractPort,
  input: {
    question: string
    existingProfile?: ConversationProfile
    now: string
    extractionPolicy?: ExtractionPolicy
  },
): Promise<StructuredFacts> {
  const now = input.now

  // 意图层已经禁用了 productIntent 抽取 → 无论如何不让 LLM 改商品栏
  // 向后兼容：没给 policy 时退回老关键词守护
  const policy = input.extractionPolicy
  const askingForInfo = policy ? !policy.allowProductIntent : isInfoOrImageRequest(input.question)
  const blockPeriod = policy ? !policy.allowPeriod : false

  try {
    const raw = await port.extract({ question: input.question, existing: input.existingProfile })
    const extracted = {
      rentalPeriod: normalizeRawRentalPeriod(raw.rentalPeriod),
      productIntent: normalizeRawProductIntent(raw.productIntent),
    }

    // 如果 LLM 只给出 startDate（比如单日租赁场景漏了 endDate），自动补成同一天
    // 再统一规范化成 "YYYY-M-D"——防止中文"5月10日"漏网到下游
    let rentalStart = coerceToIsoDate(extracted.rentalPeriod?.startDate ?? undefined)
    let rentalEnd = coerceToIsoDate(extracted.rentalPeriod?.endDate ?? undefined)
    if (rentalStart && !rentalEnd) rentalEnd = rentalStart
    if (!rentalStart && rentalEnd) rentalStart = rentalEnd
    const productIntentText = askingForInfo
      ? undefined
      : normalizeSpecificProductText(extracted.productIntent?.currentProductText)
    const allowPeriodOut = !blockPeriod
    return {
      rentalPeriod:
        allowPeriodOut && (rentalStart || rentalEnd)
          ? {
              startDate: rentalStart,
              endDate: rentalEnd,
              source: 'message',
              lastMentionedAt: now,
            }
          : undefined,
      productIntent: productIntentText
        ? {
            currentProductText: productIntentText,
            source: 'message',
            lastMentionedAt: now,
          }
        : undefined,
    }
  } catch {
    return {
      rentalPeriod: blockPeriod ? undefined : extractRentalPeriodFromText(input.question, now),
      productIntent: askingForInfo ? undefined : extractProductIntentFromText(input.question, now),
    }
  }
}

// ============ ④⑤ 完整融合：一轮消息 → 结构化事实包 ============

export interface TurnFacts {
  policy: ExtractionPolicy
  /** 确定性信号正交放行后的最终 body 开关（rag.ts L247） */
  allowBody: boolean
  /** 确定性信号正交放行后的最终 period 开关（rag.ts L248-249） */
  allowPeriod: boolean
  providedBody?: ProvidedBody
  providedPeriod?: ProvidedPeriod
  providedQuantity?: ProvidedQuantity
  /** LLM 端口的结构化抽取结果（已做归一化 + 门控） */
  structuredFacts: StructuredFacts
  /** ⑤ productText 门控后的最终生效商品文本（fromFacts ?? existing ?? default） */
  effectiveProductText?: string
  /** 喂给记忆路径的融合事实：档期 = LLM 优先 + regex 补缺；商品 = 门控后的 LLM 结果 */
  fusedFacts: StructuredFacts
}

/**
 * 主管道 ④⑤ 的完整融合逻辑（平移 rag.ts L242-295）：
 * 1. extractionPolicy 按意图门控，但身高体重/日期这类确定性信号正交放行
 *    （all-in-one 一句话给全的关键——单意图不吞并同句里的其他事实）；
 * 2. regex 抽取 + LLM 抽取端口（needsLLMFactExtract 门控）+ 融合
 *    （LLM 优先、regex 补缺、单日租赁 endDate=startDate、isUpdating 正则）；
 * 3. productText 门控：仅 allowProductIntent 时吃本轮抽取，防"发我所有款式图片"
 *    污染商品栏；sessionContext.defaultProductText 兜底保留。
 */
export async function extractTurnFacts(
  port: ExtractPort,
  input: {
    question: string
    intent: UserIntent
    existingProfile?: ConversationProfile
    /** 商品链接绑定的默认款式文本（sessionContext.defaultProductText） */
    defaultProductText?: string
    now: string
  },
): Promise<TurnFacts> {
  const { question, now } = input
  const policy = intentToExtractionPolicy(input.intent)

  // 身高体重/档期是确定性可解析的信号，与 intent 正交：本句只要确定性命中就放行抽取，
  // 避免单意图（如 select_product）把同一句里一并给出的体型/档期丢弃
  const allowBody = policy.allowBody || /身高|体重|cm|kg|公斤|斤/i.test(question)
  const allowPeriod = policy.allowPeriod || /[0-9]{1,2}\s*月|[0-9]{1,2}\s*[日号]/.test(question)

  // 只在允许抽体型时才从当前消息解析身高/体重
  const providedBody = allowBody ? extractProvidedBody(question) : undefined
  // 件数：和 body / period 一样都属于"客户主动给信息"，沿用同样的 gate
  const providedQuantity = allowBody || allowPeriod ? extractProvidedQuantity(question) : undefined

  // 意图或确定性信号允许就调 LLM 抽事实
  const needsLLMFactExtract =
    (policy.allowProductIntent || allowPeriod) &&
    /[0-9]|月|日|号|想租|想要|要租|换成|改成|想换成|意向|款式|商品|年/.test(question)
  const structuredFacts: StructuredFacts = needsLLMFactExtract
    ? await extractStructuredFacts(port, {
        question,
        existingProfile: input.existingProfile,
        now,
        extractionPolicy: policy,
      })
    : { rentalPeriod: undefined, productIntent: undefined }

  // 融合 LLM 和正则 fallback：LLM 优先，缺字段正则补；最后单日租赁自动补 endDate=startDate
  const fallbackPeriod = allowPeriod ? extractRentalPeriodFromText(question, now) : undefined
  const llmStart = structuredFacts.rentalPeriod?.startDate
  const llmEnd = structuredFacts.rentalPeriod?.endDate
  const mergedStart = llmStart ?? fallbackPeriod?.startDate
  const mergedEnd = llmEnd ?? fallbackPeriod?.endDate ?? mergedStart
  const providedPeriod: ProvidedPeriod | undefined =
    mergedStart || mergedEnd
      ? {
          startDate: mergedStart,
          endDate: mergedEnd,
          isUpdating: /修改|改下|改成|改为|更新|调整/.test(question),
        }
      : undefined

  // 只有当 intent 允许切换商品时才吃本轮新抽取出来的 productText；
  // 否则即便 LLM 抽出了什么，也不覆盖已有商品（解决"发我所有款式图片"污染商品栏的问题）
  const productTextFromFacts = policy.allowProductIntent
    ? structuredFacts.productIntent?.currentProductText
    : undefined
  const productTextExisting = input.existingProfile?.productIntent?.currentProductText
  const defaultProductText = input.defaultProductText?.trim() || undefined
  const effectiveProductText = productTextFromFacts ?? productTextExisting ?? defaultProductText

  // 记忆路径吃融合结果（刻意差异，见文件头注释）：
  // 档期 = providedPeriod（LLM 优先、regex 补缺）；商品 = 门控后的 LLM 抽取
  const fusedFacts: StructuredFacts = {
    rentalPeriod: providedPeriod
      ? {
          startDate: providedPeriod.startDate,
          endDate: providedPeriod.endDate,
          source: 'message',
          lastMentionedAt: now,
        }
      : undefined,
    productIntent: productTextFromFacts ? structuredFacts.productIntent : undefined,
  }

  return {
    policy,
    allowBody,
    allowPeriod,
    providedBody,
    providedPeriod,
    providedQuantity,
    structuredFacts,
    effectiveProductText,
    fusedFacts,
  }
}
