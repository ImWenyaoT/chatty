import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryAvailability } from './availability-service.js';
import { deriveConversationOrchestration } from './conversation-orchestrator.js';
import { config } from './config.js';
import { openai } from './openai.js';
import {
  buildCurrentMonthDate,
  buildCurrentYearMonthDate,
  coerceToIsoDate,
  coerceToIsoDateRange,
  normalizeDateText,
} from './parsers/date.js';
import {
  extractHeightWeightFromText,
  extractQuantityFromText,
  normalizeNumber,
} from './parsers/measurements.js';
import { findProduct, loaded, pickSizeByMeasurement } from './prompts-loader.js';
import { evaluateCustomerServiceReply } from './rag.js';
import {
  AvailabilityCheck,
  BodyProfile,
  ConversationProfile,
  CustomerMemory,
  MemoryMessage,
  OrderReadiness,
  PriceQuote,
  ProductIntent,
  ProductMemory,
  QuantityInfo,
  RentalPeriod,
  SizeRecommendation,
} from './types.js';

const MAX_RECENT_MESSAGES = 6;

function createMessage(
  role: 'user' | 'assistant',
  content: string,
  timestamp: string,
  extra?: Partial<MemoryMessage>,
): MemoryMessage {
  return { role, content, timestamp, ...extra };
}

function resolveMemoryPath() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '..', config.memoryStorePath);
}

async function readMemoryMap(): Promise<Record<string, CustomerMemory>> {
  const storePath = resolveMemoryPath();
  try {
    const content = await fs.readFile(storePath, 'utf8');
    return JSON.parse(content) as Record<string, CustomerMemory>;
  } catch {
    return {};
  }
}

async function writeMemoryMap(data: Record<string, CustomerMemory>) {
  const storePath = resolveMemoryPath();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(data, null, 2), 'utf8');
}

// 串行化所有 memory-store.json 的读写，避免异步评估与 /chat 并发写丢数据。
let memoryLock: Promise<unknown> = Promise.resolve();
function runWithMemoryLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = memoryLock.then(() => fn());
  memoryLock = next.catch(() => undefined);
  return next;
}

// 等待所有异步评估落盘（测试/脚本用，日常 HTTP 链路不需要）。
export function flushPendingReviews() {
  return runWithMemoryLock(async () => {});
}

function buildConversationId(customerId: string, productId?: string, conversationId?: string) {
  if (conversationId) return conversationId;
  return productId ? `${customerId}:${productId}` : `${customerId}:general`;
}

function isInvalidSystemReview(review: { score: number; source: string; issues?: string[]; suggestions?: string[] }) {
  return (
    review.source === 'system' &&
    review.score === 0 &&
    Array.isArray(review.issues) &&
    review.issues.some((item) => /评分解析失败|返回默认结果|评价失败/i.test(item)) &&
    Array.isArray(review.suggestions) &&
    review.suggestions.some((item) => /请检查模型输出格式|评估模型可用性|检查模型配置/i.test(item))
  );
}

async function extractConversationFactsWithModel(input: {
  question: string;
  existingProfile?: ConversationProfile;
}) {
  const now = new Date();
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const existingRentalPeriod = input.existingProfile?.rentalPeriod;
  const existingProductText = input.existingProfile?.productIntent?.currentProductText;

  const payload = JSON.stringify({
    question: input.question,
    existingRentalPeriod: existingRentalPeriod
      ? {
          startDate: existingRentalPeriod.startDate ?? null,
          endDate: existingRentalPeriod.endDate ?? null,
        }
      : null,
    existingProductIntent: existingProductText ?? null,
  });

  const response = await openai.chat.completions.create({
    model: config.chatModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `${loaded.prompts.factExtractorSystemPrompt}\n今天日期是 ${today}。`,
      },
      {
        // 某些 provider（含 OneAPI/Azure 等）要求使用 response_format=json_object 时
        // user 消息里必须含有 "json" 字眼。
        // 输出必须严格按 system prompt 定义的 { rentalPeriod, productIntent } schema，
        // 不要回显输入字段（曾经因此返回了 existingProductIntent 等字段污染输出）。
        role: 'user',
        content: `请按 system 里规定的 JSON 输出 schema（字段：rentalPeriod, productIntent）抽取下面这条输入，只输出符合 schema 的 JSON：\n${payload}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as Record<string, unknown>;

  // 兼容 LLM 返回简化的字符串形式（"productIntent": "黑色西装"）
  const normalizedProductIntent = (() => {
    const p = parsed.productIntent;
    if (!p) return null;
    if (typeof p === 'string') {
      return p.trim() ? { currentProductText: p.trim() } : null;
    }
    if (typeof p === 'object') {
      const obj = p as Record<string, unknown>;
      const raw = obj.currentProductText ?? obj.text ?? obj.name;
      return typeof raw === 'string' && raw.trim()
        ? { currentProductText: raw.trim() }
        : null;
    }
    return null;
  })();

  // LLM 返回形态兼容：
  //   1) {startDate,endDate}  2) {start,end}  3) 字符串 "5月10日-5月12日"
  //   并且把任何中文日期统一 normalize 成 "YYYY-M-D"
  const normalizedRentalPeriod = (() => {
    const r = parsed.rentalPeriod;
    if (!r) return null;
    if (typeof r === 'string') {
      const { startDate, endDate } = coerceToIsoDateRange(r);
      if (!startDate && !endDate) return null;
      return { startDate: startDate ?? null, endDate: endDate ?? null };
    }
    if (typeof r === 'object') {
      const obj = r as Record<string, unknown>;
      const startRaw =
        (typeof obj.startDate === 'string' && obj.startDate) ||
        (typeof obj.start === 'string' && obj.start) ||
        null;
      const endRaw =
        (typeof obj.endDate === 'string' && obj.endDate) ||
        (typeof obj.end === 'string' && obj.end) ||
        null;
      const startDate = startRaw ? coerceToIsoDate(startRaw) : undefined;
      const endDate = endRaw ? coerceToIsoDate(endRaw) : undefined;
      if (!startDate && !endDate) return null;
      return { startDate: startDate ?? null, endDate: endDate ?? null };
    }
    return null;
  })();

  return {
    rentalPeriod: normalizedRentalPeriod,
    productIntent: normalizedProductIntent,
  };
}

// 判断用户这句话是不是在请求"信息/图片/尺码表/链接"类的东西——
// 这类是"询问"而非"选款/换款"，不应让 productIntent 被更新（否则会把
// "所有款式的图片"写进商品栏）。
export function isInfoOrImageRequest(text: string) {
  const q = text.replace(/\s+/g, '');
  // 图片/照片/链接/尺码表/价格表/样图 等信息请求
  if (/图片|图|照片|示意图|样图|样式图|款式图|尺码表|价格表|价目表|清单|列表|链接|网址|看[下看]?一?下/.test(q)) {
    // 不要误伤"图片"出现在商品名里的罕见情况——如果用户明确说"租"/"想要"某款，
    // 即便句子里有"图"字也应视为选款意图。通过"明显选款动词 + 具体实体"豁免。
    if (/(?:想租|要租|租下|选[定了]?|换成|改成).{0,10}(?:[黑白红蓝灰紫绿金银粉卡]色|双排扣|单排扣|三件套|两件套|燕尾|礼服|旗袍|SUIT[-_ ]?\d+|款)/.test(q)) {
      return false;
    }
    return true;
  }
  return false;
}

// 判断一段文本是不是"具体到某个款/某件商品"。如果只是"租衣服""要套装"
// 这种泛指动词+品类词，返回 undefined；否则返回清洗后的具体描述。
// 导出给 extractProductIntentFromText 的正则回退路径复用。
export function normalizeSpecificProductText(text?: string | null) {
  const raw = text?.trim();
  if (!raw) return undefined;

  // 1) 剥离意图动词/指示词前缀：我想/想/要/想要/想租/要租/租/买/挑/看/找…
  //    以及后缀口语粘词
  const stripped = raw
    .replace(/^我?/, '')
    .replace(/^(?:想要|打算|准备|计划|要想|要|想)+/, '')
    .replace(/^(?:租|买|挑|选|找|搞|整|来|看)+/, '')
    .replace(/^(?:一|几)[件套个条]/, '')
    .replace(/[的啊呀吧呢嘛哇哦嗯][？。！?!.]*$/, '')
    .trim();
  const candidate = stripped || raw;

  // 2) 完整命中泛指品类词，直接丢弃
  const GENERIC = /^(?:衣服|服装|服饰|衣物|西服|西装|礼服|款式|商品|东西|套装|外套|上衣|下装|裤子|裙子|大衣|毛衣|衬衫|男装|女装|童装|鞋子?|包|配饰|行头|搭配)$/i;
  if (GENERIC.test(candidate)) return undefined;

  // 3) 1-2 字纯中文基本都是泛指（具体款至少"黑西装""三件套"这种 3 字起）
  if (candidate.length <= 2 && /^[\u4e00-\u9fa5]+$/.test(candidate)) return undefined;

  return candidate;
}

export async function extractStructuredConversationFacts(input: {
  question: string;
  existingProfile?: ConversationProfile;
  now?: string;
  // 上游 intent-classifier 算出的抽取策略——权威来源。
  // 如果没传（向后兼容），退回关键词判断（isInfoOrImageRequest）。
  extractionPolicy?: { allowProductIntent: boolean; allowPeriod: boolean; allowBody: boolean };
}) {
  const now = input.now ?? new Date().toISOString();
  const normalizeGenericProductText = normalizeSpecificProductText;

  // 意图层已经禁用了 productIntent 抽取 → 无论如何不让 LLM 改商品栏
  // 向后兼容：没给 policy 时退回老关键词守护
  const policy = input.extractionPolicy;
  const askingForInfo = policy
    ? !policy.allowProductIntent
    : isInfoOrImageRequest(input.question);
  const blockPeriod = policy ? !policy.allowPeriod : false;

  try {
    const extracted = await extractConversationFactsWithModel({
      question: input.question,
      existingProfile: input.existingProfile,
    });

    // 如果 LLM 只给出 startDate（比如单日租赁场景漏了 endDate），自动补成同一天
    // 再统一规范化成 "YYYY-M-D"——防止中文"5月10日"漏网到下游
    let rentalStart = coerceToIsoDate(extracted.rentalPeriod?.startDate ?? undefined);
    let rentalEnd = coerceToIsoDate(extracted.rentalPeriod?.endDate ?? undefined);
    if (rentalStart && !rentalEnd) rentalEnd = rentalStart;
    if (!rentalStart && rentalEnd) rentalStart = rentalEnd;
    const productIntentText = askingForInfo
      ? undefined
      : normalizeGenericProductText(extracted.productIntent?.currentProductText);
    const allowPeriodOut = !blockPeriod;
    return {
      rentalPeriod:
        allowPeriodOut && (rentalStart || rentalEnd)
          ? {
              startDate: rentalStart,
              endDate: rentalEnd,
              source: 'message' as const,
              lastMentionedAt: now,
            }
          : undefined,
      productIntent: productIntentText
        ? {
            currentProductText: productIntentText,
            source: 'message' as const,
            lastMentionedAt: now,
          }
        : undefined,
    };
  } catch {
    return {
      rentalPeriod: blockPeriod ? undefined : extractRentalPeriodFromText(input.question),
      productIntent: askingForInfo ? undefined : extractProductIntentFromText(input.question),
    };
  }
}

function extractRentalPeriodFromText(rawText: string): RentalPeriod | undefined {
  // 压掉所有空白后再处理，兼容 "5 月 10 号" 这种带空格的输入
  const text = rawText.replace(/\s+/g, '');
  const normalized = text
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/号/g, '')
    .trim();
  const datePattern = '([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2})';

  const updateEndMatch = normalized.match(new RegExp('(?:到|至|改到|改成|改为)?\\s*' + datePattern + '\\s*(?:结束|截止|归还|为止)', 'i'));
  if (updateEndMatch) {
    return {
      endDate: normalizeDateText(updateEndMatch[1]),
      source: 'message',
      lastMentionedAt: new Date().toISOString(),
    };
  }

  const rangeMatch = normalized.match(new RegExp(datePattern + '\\s*(?:到|至|~|—|-|--|－)\\s*' + datePattern, 'i'));
  if (rangeMatch) {
    return {
      startDate: normalizeDateText(rangeMatch[1]),
      endDate: normalizeDateText(rangeMatch[2]),
      source: 'message',
      lastMentionedAt: new Date().toISOString(),
    };
  }

  const startMatch = normalized.match(new RegExp('(?:开始时间|租赁开始|租期开始|开始日期|起租时间|起始时间)[:： ]*' + datePattern, 'i'));
  const endMatch = normalized.match(new RegExp('(?:结束时间|租赁结束|租期结束|结束日期|归还时间|截止时间)[:： ]*' + datePattern, 'i'));
  if (startMatch || endMatch) {
    return {
      startDate: startMatch ? normalizeDateText(startMatch[1]) : undefined,
      endDate: endMatch ? normalizeDateText(endMatch[1]) : undefined,
      source: 'message',
      lastMentionedAt: new Date().toISOString(),
    };
  }

  const monthDayRangeMatch = text.match(/([0-9]{1,2})月([0-9]{1,2})(?:日|号)?\s*(?:到|至|~|—|-|--|－)\s*([0-9]{1,2})月([0-9]{1,2})(?:日|号)?/i);
  if (monthDayRangeMatch) {
    return {
      startDate: buildCurrentYearMonthDate(Number(monthDayRangeMatch[1]), Number(monthDayRangeMatch[2])),
      endDate: buildCurrentYearMonthDate(Number(monthDayRangeMatch[3]), Number(monthDayRangeMatch[4])),
      source: 'message',
      lastMentionedAt: new Date().toISOString(),
    };
  }

  // 同月跨日：「5月9号到10号」第二段省略月份，结束日沿用开始月份（与 rag.ts 的 fallback 保持一致）
  const sameMonthDayRangeMatch = text.match(/([0-9]{1,2})月([0-9]{1,2})(?:日|号)?\s*(?:到|至|~|—|-|--|－)\s*([0-9]{1,2})(?:日|号)?/i);
  if (sameMonthDayRangeMatch) {
    const m = Number(sameMonthDayRangeMatch[1]);
    const d1 = Number(sameMonthDayRangeMatch[2]);
    const d2 = Number(sameMonthDayRangeMatch[3]);
    if (d2 >= d1) {
      return {
        startDate: buildCurrentYearMonthDate(m, d1),
        endDate: buildCurrentYearMonthDate(m, d2),
        source: 'message',
        lastMentionedAt: new Date().toISOString(),
      };
    }
  }

  const monthDaySingleMatch = text.match(/([0-9]{1,2})月([0-9]{1,2})(?:日|号)?(?:用|穿|租|要用|需要|开始|当天)?/i);
  if (monthDaySingleMatch) {
    const date = buildCurrentYearMonthDate(Number(monthDaySingleMatch[1]), Number(monthDaySingleMatch[2]));
    return {
      startDate: date,
      endDate: date,
      source: 'message',
      lastMentionedAt: new Date().toISOString(),
    };
  }

  const dayOnlyRangeMatch = text.match(/([0-9]{1,2})(?:日|号)\s*(?:到|至|~|—|-|--|－)\s*([0-9]{1,2})(?:日|号)/i);
  if (dayOnlyRangeMatch) {
    return {
      startDate: buildCurrentMonthDate(Number(dayOnlyRangeMatch[1])),
      endDate: buildCurrentMonthDate(Number(dayOnlyRangeMatch[2])),
      source: 'message',
      lastMentionedAt: new Date().toISOString(),
    };
  }

  const dayOnlySingleMatch = text.match(/(^|[^0-9])([0-9]{1,2})(?:日|号)(?:用|穿|租|要用|需要|开始|当天)?/i);
  if (dayOnlySingleMatch) {
    const date = buildCurrentMonthDate(Number(dayOnlySingleMatch[2]));
    return {
      startDate: date,
      endDate: date,
      source: 'message',
      lastMentionedAt: new Date().toISOString(),
    };
  }

  return undefined;
}

function extractProductIntentFromText(text: string): ProductIntent | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (isInfoOrImageRequest(normalized)) {
    return undefined;
  }
  if (/身高|体重|kg|斤|cm|厘米|档期|租赁时间|开始时间|结束时间|到\d{4}|至\d{4}|\d{4}-\d{1,2}-\d{1,2}/.test(normalized)) {
    return undefined;
  }
  const match = normalized.match(/(?:想租|想看|想要|要租|换成|改成|想换成|意向商品|款式|衣服款式|商品)[:： ]*([^，。；;]+)/i);
  if (!match) {
    return undefined;
  }

  const raw = match[1]
    .trim()
    .replace(/[，。；;,.]+$/g, '')
    .trim();
  const currentProductText = normalizeSpecificProductText(raw);
  if (!currentProductText) return undefined;

  return {
    currentProductText,
    source: 'message',
    lastMentionedAt: new Date().toISOString(),
  };
}

async function extractConversationProfile(input: {
  question: string;
  sessionContext?: Record<string, string | number | boolean | null>;
  now: string;
  existingProfile?: ConversationProfile;
  // 上游（answerQuestion）已经抽过的结果，传过来就不再调用 LLM，省一次调用
  preExtractedFacts?: {
    rentalPeriod?: RentalPeriod;
    productIntent?: ProductIntent;
  };
}): Promise<Partial<ConversationProfile>> {
  const body = extractHeightWeightFromText(input.question);
  const context = input.sessionContext ?? {};
  const extractedFacts = input.preExtractedFacts ?? await extractStructuredConversationFacts({
    question: input.question,
    existingProfile: input.existingProfile,
    now: input.now,
  });
  const rentalPeriodFromText = extractedFacts.rentalPeriod;
  const productIntentFromText = extractedFacts.productIntent;

  const rentalPeriod: RentalPeriod | undefined = rentalPeriodFromText ||
    (context.rentalStartDate || context.rentalEndDate
      ? {
          startDate: typeof context.rentalStartDate === 'string' ? normalizeDateText(context.rentalStartDate) : undefined,
          endDate: typeof context.rentalEndDate === 'string' ? normalizeDateText(context.rentalEndDate) : undefined,
          source: 'sessionContext',
          lastMentionedAt: input.now,
        }
      : undefined);

  const productIntentText = typeof context.productIntentText === 'string'
    ? context.productIntentText.trim()
    : typeof context.productText === 'string'
      ? context.productText.trim()
      : undefined;
  const existingProductText = input.existingProfile?.productIntent?.currentProductText?.trim();

  const productIntent: ProductIntent | undefined = productIntentFromText ||
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
      : undefined);

  const quantityCount = extractQuantityFromText(input.question);
  const quantity: QuantityInfo | undefined = quantityCount !== undefined
    ? {
        count: quantityCount,
        isExplicit: true,
        source: 'message',
        lastMentionedAt: input.now,
      }
    : undefined;

  return {
    heightCm: body.heightCm,
    weightKg: body.weightKg,
    rentalPeriod,
    productIntent,
    quantity,
    updatedAt: input.now,
  };
}

function mergeConversationProfile(
  existingProfile: ConversationProfile | undefined,
  incomingProfile: Partial<ConversationProfile>,
  now: string,
): ConversationProfile {
  const incomingProductText = incomingProfile.productIntent?.currentProductText?.trim();
  const existingProductText = existingProfile?.productIntent?.currentProductText?.trim();
  const shouldDropExistingProductText = !!existingProductText && /^(?:[0-9]+(?:\.[0-9]+)?\s*(?:kg|斤|cm)|60kg)$/i.test(existingProductText);

  return {
    heightCm: incomingProfile.heightCm ?? existingProfile?.heightCm,
    weightKg: incomingProfile.weightKg ?? existingProfile?.weightKg,
    rentalPeriod: incomingProfile.rentalPeriod
      ? {
          startDate: incomingProfile.rentalPeriod.startDate ?? existingProfile?.rentalPeriod?.startDate,
          endDate: incomingProfile.rentalPeriod.endDate ?? existingProfile?.rentalPeriod?.endDate,
          source: incomingProfile.rentalPeriod.source,
          lastMentionedAt: incomingProfile.rentalPeriod.lastMentionedAt,
        }
      : existingProfile?.rentalPeriod,
    productIntent: incomingProfile.productIntent
      ? {
          currentProductText:
            incomingProductText ?? (shouldDropExistingProductText ? undefined : existingProductText),
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
  };
}

function isUserProvidingNewFacts(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return /[0-9]/.test(normalized) || /想租|想要|黑色|白色|双排扣|单排扣|西装|礼服|衬衫|档期|身高|体重|kg|斤|cm|月|日|号/.test(normalized);
}

function updateProactiveFollowUpState(input: {
  existingProfile?: ConversationProfile;
  nextProfile: ConversationProfile;
  question: string;
  answer: string;
  now: string;
}) {
  const orchestration = input.nextProfile.orchestration;
  if (!orchestration) {
    return input.nextProfile;
  }

  const previous = input.existingProfile?.orchestration;
  const previousCount = previous?.proactiveFollowUpCount ?? 0;
  const previousStage = previous?.stage;
  const stageChanged = previousStage && previousStage !== orchestration.stage;
  const userProvidedNewFacts = isUserProvidingNewFacts(input.question);
  const askedFollowUp = !!orchestration.followUpQuestion && input.answer.includes(orchestration.followUpQuestion);

  let proactiveFollowUpCount = previousCount;
  if (stageChanged || userProvidedNewFacts) {
    proactiveFollowUpCount = 0;
  }
  if (askedFollowUp) {
    proactiveFollowUpCount += 1;
  }

  const proactiveFollowUpLimit = orchestration.proactiveFollowUpLimit ?? 2;
  const paused = proactiveFollowUpCount >= proactiveFollowUpLimit;

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
  };
}

function inferPriceQuote(productId: string | undefined, now: string): PriceQuote | undefined {
  const product = findProduct(productId);
  if (!product || product.dailyPrice === undefined) {
    return undefined;
  }
  return {
    dailyPrice: product.dailyPrice,
    renewalDailyPrice: product.renewalDailyPrice,
    currency: product.currency,
    shippingPolicy: product.shippingPolicy,
    pricingNote: product.pricingNote,
    source: 'manual',
    lastQuotedAt: now,
  };
}

function inferSizeRecommendation(profile: ConversationProfile, now: string): SizeRecommendation | undefined {
  const missingFields: string[] = [];
  if (profile.heightCm === undefined) missingFields.push('heightCm');
  if (profile.weightKg === undefined) missingFields.push('weightKg');

  if (missingFields.length > 0) {
    return { missingFields, source: 'rule', lastRecommendedAt: now };
  }

  const picked = pickSizeByMeasurement(profile.heightCm as number, profile.weightKg as number);
  return {
    recommendedSize: picked.size,
    confidence: picked.confidence,
    source: 'rule',
    lastRecommendedAt: now,
  };
}

async function inferAvailabilityCheck(
  profile: ConversationProfile,
  now: string,
  sizeRecommendation?: SizeRecommendation,
  productId?: string,
): Promise<AvailabilityCheck | undefined> {
  const recommendedSize = sizeRecommendation?.recommendedSize ?? profile.sizeRecommendation?.recommendedSize;
  const hasSchedule = !!profile.rentalPeriod?.startDate && !!profile.rentalPeriod?.endDate;
  const hasBodyMeasurements = profile.heightCm !== undefined && profile.weightKg !== undefined;

  if (!productId || !hasSchedule || !hasBodyMeasurements) {
    return undefined;
  }

  const result = await queryAvailability({
    productId,
    heightCm: profile.heightCm as number,
    weightKg: profile.weightKg as number,
    rentalStartDate: profile.rentalPeriod?.startDate as string,
    rentalEndDate: profile.rentalPeriod?.endDate as string,
  });

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
  };
}

function inferOrderReadiness(
  profile: ConversationProfile,
  productId: string | undefined,
  now: string,
  sizeRecommendation?: SizeRecommendation,
  availabilityCheck?: AvailabilityCheck,
): OrderReadiness {
  const reviewCheck = profile.reviewCheck;
  if (profile.orderPlacement?.orderNo) {
    const needReviewCheck = !(reviewCheck?.completed && reviewCheck?.passed);
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
    };
  }

  const hasConfirmedProduct = !!(profile.productIntent?.currentProductText || productId);
  const needProductId = !hasConfirmedProduct;
  const needRentalPeriod = !profile.rentalPeriod?.startDate || !profile.rentalPeriod?.endDate;
  const needHeightWeight = profile.heightCm === undefined || profile.weightKg === undefined;
  const recommendedSize = availabilityCheck?.availableSize
    ?? profile.availabilityCheck?.availableSize
    ?? sizeRecommendation?.recommendedSize
    ?? profile.sizeRecommendation?.recommendedSize;
  const hasSchedule = availabilityCheck?.hasSchedule ?? profile.availabilityCheck?.hasSchedule ?? false;
  const hasSize = availabilityCheck?.hasSize ?? profile.availabilityCheck?.hasSize ?? false;
  const needSizeRecommendation = !recommendedSize;
  const needAvailabilityCheck = !hasSchedule || !hasSize;
  const needReviewCheck = !needProductId
    && !needRentalPeriod
    && !needHeightWeight
    && !needSizeRecommendation
    && !needAvailabilityCheck
    && !(reviewCheck?.completed && reviewCheck?.passed);
  const readyToOrder = !needProductId
    && !needRentalPeriod
    && !needHeightWeight
    && !needSizeRecommendation
    && !needAvailabilityCheck
    && !needReviewCheck;
  // 数量默认 1，所以不参与 readyToOrder 判定，只用于 follow-up 文案
  const needQuantity = !(profile.quantity?.isExplicit);

  let nextStep = '继续确认需求';
  if (needProductId) {
    nextStep = '确认商品';
  } else if (needRentalPeriod) {
    nextStep = '确认租赁日期';
  } else if (needHeightWeight) {
    nextStep = '确认身高体重';
  } else if (needSizeRecommendation) {
    nextStep = '确认尺码';
  } else if (needAvailabilityCheck) {
    nextStep = '确认档期和库存';
  } else if (needReviewCheck) {
    nextStep = '和用户复核关键信息';
  } else if (readyToOrder) {
    nextStep = '引导下单';
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
  };
}

function extractProfilesFromInput(input: {
  question: string;
  sessionContext?: Record<string, string | number | boolean | null>;
  now: string;
}) {
  const profiles: BodyProfile[] = [];
  const fromQuestion = extractHeightWeightFromText(input.question);
  if (fromQuestion.heightCm !== undefined || fromQuestion.weightKg !== undefined) {
    profiles.push({
      profileId: 'default',
      label: '默认档案',
      heightCm: fromQuestion.heightCm,
      weightKg: fromQuestion.weightKg,
      source: 'message',
      lastMentionedAt: input.now,
    });
  }

  const context = input.sessionContext ?? {};
  const profilePrefixMap = new Map<string, Partial<BodyProfile>>();
  for (const [key, rawValue] of Object.entries(context)) {
    if (rawValue === null || rawValue === '') {
      continue;
    }

    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    const profileMatch = key.match(/^profile([A-Za-z0-9_-]+)(HeightCm|WeightKg|Label)$/);
    if (profileMatch) {
      const profileId = profileMatch[1].toLowerCase();
      const field = profileMatch[2];
      const current = profilePrefixMap.get(profileId) ?? {};
      if (field === 'HeightCm' && Number.isFinite(value)) {
        current.heightCm = normalizeNumber(value);
      }
      if (field === 'WeightKg' && Number.isFinite(value)) {
        current.weightKg = normalizeNumber(value);
      }
      if (field === 'Label') {
        current.label = String(rawValue);
      }
      profilePrefixMap.set(profileId, current);
      continue;
    }

    if (key === 'heightCm' || key === 'weightKg') {
      const current = profilePrefixMap.get('default') ?? {};
      if (key === 'heightCm' && Number.isFinite(value)) {
        current.heightCm = normalizeNumber(value);
      }
      if (key === 'weightKg' && Number.isFinite(value)) {
        current.weightKg = normalizeNumber(value);
      }
      profilePrefixMap.set('default', current);
    }
  }

  for (const [profileId, partial] of profilePrefixMap.entries()) {
    if (partial.heightCm === undefined && partial.weightKg === undefined) {
      continue;
    }
    profiles.push({
      profileId,
      label: partial.label || (profileId === 'default' ? '默认档案' : `档案 ${profileId}`),
      heightCm: partial.heightCm,
      weightKg: partial.weightKg,
      source: 'sessionContext',
      lastMentionedAt: input.now,
    });
  }

  return profiles;
}

function mergeBodyProfiles(existingProfiles: BodyProfile[], incomingProfiles: BodyProfile[]) {
  const profileMap = new Map(existingProfiles.map((profile) => [profile.profileId, profile]));
  for (const incoming of incomingProfiles) {
    const existing = profileMap.get(incoming.profileId);
    profileMap.set(incoming.profileId, {
      profileId: incoming.profileId,
      label: incoming.label || existing?.label || '默认档案',
      heightCm: incoming.heightCm ?? existing?.heightCm,
      weightKg: incoming.weightKg ?? existing?.weightKg,
      source: incoming.source,
      lastMentionedAt: incoming.lastMentionedAt,
      notes: incoming.notes ?? existing?.notes,
    });
  }

  return Array.from(profileMap.values()).sort((left, right) =>
    right.lastMentionedAt.localeCompare(left.lastMentionedAt),
  );
}

function buildGlobalSummary(
  existingSummary: string,
  sessionContext: Record<string, string | number | boolean | null> | undefined,
  question: string,
  bodyProfiles: BodyProfile[],
) {
  const facts = sessionContext
    ? Object.entries(sessionContext)
        .filter(([, value]) => value !== null && value !== '')
        .filter(([key]) => !/^profile[A-Za-z0-9_-]+(HeightCm|WeightKg|Label)$/.test(key))
        .filter(([key]) => key !== 'heightCm' && key !== 'weightKg')
        .map(([key, value]) => `${key}: ${String(value)}`)
    : [];

  const summaryLines: string[] = [];
  if (existingSummary.trim()) {
    const firstLine = existingSummary.split('\n').find((line) => line.trim());
    if (firstLine) {
      summaryLines.push(firstLine);
    }
  }
  if (facts.length > 0) {
    summaryLines.push(`客户已知信息: ${facts.join(' | ')}`);
  }
  if (bodyProfiles.length > 0) {
    const profileSummary = bodyProfiles
      .map((profile) => {
        const parts = [profile.label];
        if (profile.heightCm !== undefined) parts.push(`身高${profile.heightCm}cm`);
        if (profile.weightKg !== undefined) parts.push(`体重${profile.weightKg}kg`);
        return parts.join(' ');
      })
      .join(' | ');
    summaryLines.push(`客户体型档案: ${profileSummary}`);
  }
  summaryLines.push(`最近意图: ${question}`);
  return summaryLines.slice(-3).join('\n');
}

function buildProductSummary(existingSummary: string, recentMessages: MemoryMessage[]) {
  const recentUserMessages = recentMessages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => message.content);

  const recentAssistantMessages = recentMessages
    .filter((message) => message.role === 'assistant')
    .slice(-2)
    .map((message) => message.content);

  const parts = existingSummary.trim() ? [existingSummary.trim().split('\n')[0]] : [];
  if (recentUserMessages.length > 0) {
    parts.push(`用户最近关注: ${recentUserMessages.join(' | ')}`);
  }
  if (recentAssistantMessages.length > 0) {
    parts.push(`已回复要点: ${recentAssistantMessages.join(' | ')}`);
  }

  return parts.slice(-3).join('\n');
}

function buildConversationProfileSummary(profile: ConversationProfile) {
  const parts: string[] = [];
  if (profile.heightCm !== undefined) {
    parts.push(`身高${profile.heightCm}cm`);
  }
  if (profile.weightKg !== undefined) {
    parts.push(`体重${profile.weightKg}kg`);
  }
  if (profile.rentalPeriod?.startDate || profile.rentalPeriod?.endDate) {
    parts.push(`档期${profile.rentalPeriod?.startDate ?? '?'} 到 ${profile.rentalPeriod?.endDate ?? '?'}`);
  }
  if (profile.productIntent?.currentProductText) {
    parts.push(`意向商品${profile.productIntent.currentProductText}`);
  }
  if (profile.quantity?.count !== undefined) {
    const tag = profile.quantity.isExplicit ? '' : '默认';
    parts.push(`数量${tag}${profile.quantity.count}件`);
  }
  if (profile.sizeRecommendation?.recommendedSize) {
    parts.push(`推荐尺码${profile.sizeRecommendation.recommendedSize}`);
  }
  if (profile.reviewCheck) {
    if (profile.reviewCheck.completed && profile.reviewCheck.passed) {
      parts.push('复核已通过');
    } else if (profile.reviewCheck.completed && !profile.reviewCheck.passed) {
      parts.push(`复核失败${profile.reviewCheck.failureReason ? `:${profile.reviewCheck.failureReason}` : ''}`);
    } else if (profile.reviewCheck.needed) {
      parts.push('待复核');
    }
  }
  if (profile.orderReadiness?.nextStep) {
    parts.push(`下一步${profile.orderReadiness.nextStep}`);
  }
  if (profile.orderPlacement?.orderNo) {
    parts.push(`订单号${profile.orderPlacement.orderNo}`);
  }
  if (profile.handoffStatus?.needed && profile.handoffStatus.reason) {
    parts.push(`人工接管${profile.handoffStatus.reason}`);
  }
  if (profile.orchestration?.stage) {
    parts.push(`阶段${profile.orchestration.stage}`);
  }
  return parts.join(' | ');
}

export async function markOrderPlaced(input: {
  customerId: string;
  productId?: string;
  conversationId?: string;
  orderNo: string;
}) {
  return runWithMemoryLock(() => markOrderPlacedInternal(input));
}

async function markOrderPlacedInternal(input: {
  customerId: string;
  productId?: string;
  conversationId?: string;
  orderNo: string;
}) {
  const memoryMap = await readMemoryMap();
  const now = new Date().toISOString();
  const conversationKey = buildConversationId(input.customerId, input.productId, input.conversationId);

  const customerMemory: CustomerMemory = memoryMap[input.customerId] ?? {
    customerId: input.customerId,
    globalSummary: '',
    sessionContext: {},
    bodyProfiles: [],
    productMemories: {},
    updatedAt: now,
  };

  const productMemory: ProductMemory = customerMemory.productMemories[conversationKey] ?? {
    productId: input.productId ?? 'general',
    conversationId: conversationKey,
    summary: '',
    recentMessages: [],
    conversationProfile: {
    reviews: [],
      updatedAt: now,
    },
    updatedAt: now,
  };

  const orderConfirmationReply = '收到订单，感谢您的信任，我们会按时发货寄到您手上。';
  const existingReview = productMemory.conversationProfile.reviewCheck;
  const needPostOrderReview = !(existingReview?.completed && existingReview?.passed);

  const nextProfile: ConversationProfile = {
    ...productMemory.conversationProfile,
    orderPlacement: {
      orderNo: input.orderNo,
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
    orderReadiness: productMemory.conversationProfile.orderReadiness
      ? {
          ...productMemory.conversationProfile.orderReadiness,
          needReviewCheck: needPostOrderReview,
          readyToOrder: false,
          nextStep: needPostOrderReview ? '已下单待复核' : '已下单待跟进',
          updatedAt: now,
        }
      : undefined,
    orchestration: productMemory.conversationProfile.orchestration
      ? {
          ...productMemory.conversationProfile.orchestration,
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
  };

  productMemory.conversationProfile = nextProfile;
  productMemory.recentMessages = [
    ...productMemory.recentMessages,
    createMessage('assistant', orderConfirmationReply, now),
  ].slice(-MAX_RECENT_MESSAGES);
  const conversationProfileSummary = buildConversationProfileSummary(productMemory.conversationProfile);
  productMemory.summary = [
    conversationProfileSummary ? `当前会话资料: ${conversationProfileSummary}` : '',
    buildProductSummary(productMemory.summary, productMemory.recentMessages),
  ]
    .filter(Boolean)
    .slice(-3)
    .join('\n');
  productMemory.updatedAt = now;

  customerMemory.productMemories[conversationKey] = productMemory;
  customerMemory.updatedAt = now;
  memoryMap[input.customerId] = customerMemory;

  await writeMemoryMap(memoryMap);

  return {
    customerMemory,
    productMemory,
  };
}

export async function getCustomerMemory(customerId: string) {
  const memoryMap = await readMemoryMap();
  return memoryMap[customerId] ?? null;
}

export async function getProductMemory(customerId: string, productId?: string, conversationId?: string) {
  const customerMemory = await getCustomerMemory(customerId);
  if (!customerMemory) return null;
  const key = buildConversationId(customerId, productId, conversationId);
  return customerMemory.productMemories[key] ?? null;
}

export async function getAllCustomersForListing() {
  const memoryMap = await readMemoryMap();
  return Object.values(memoryMap).map((mem) => ({
    customerId: mem.customerId,
    globalSummary: mem.globalSummary,
    overallRating: mem.overallRating,
    totalReviews: mem.totalReviews,
    updatedAt: mem.updatedAt,
    productMemories: Object.values(mem.productMemories || {}).map((pm) => ({
      productId: pm.productId,
      conversationId: pm.conversationId,
      summary: pm.summary,
      recentMessages: pm.recentMessages,
      conversationProfile: pm.conversationProfile,
      reviews: (pm.reviews || []).filter((review) => !isInvalidSystemReview(review)),
    })),
  }));
}

export async function getReviewSummary() {
  const memoryMap = await readMemoryMap();
  const byVersion = new Map<string, { version: string; count: number; scoreSum: number; lowScoreCount: number; errorCount: number }>();
  const issueCounter = new Map<string, number>();
  const suggestionCounter = new Map<string, number>();
  let totalConversations = 0;
  let totalReviews = 0;

  for (const customer of Object.values(memoryMap)) {
    for (const pm of Object.values(customer.productMemories || {})) {
      totalConversations += 1;
      for (const review of pm.reviews || []) {
        if (isInvalidSystemReview(review)) continue;
        if (review.source !== 'system') continue;
        totalReviews += 1;
        const version = review.promptVersion ?? 'unknown';
        const slot = byVersion.get(version) ?? {
          version, count: 0, scoreSum: 0, lowScoreCount: 0, errorCount: 0,
        };
        slot.count += 1;
        slot.scoreSum += review.score || 0;
        if (review.error) slot.errorCount += 1;
        if (review.score > 0 && review.score < 6) slot.lowScoreCount += 1;
        byVersion.set(version, slot);

        for (const issue of review.issues || []) {
          issueCounter.set(issue, (issueCounter.get(issue) ?? 0) + 1);
        }
        for (const sug of review.suggestions || []) {
          suggestionCounter.set(sug, (suggestionCounter.get(sug) ?? 0) + 1);
        }
      }
    }
  }

  const promptVersions = Array.from(byVersion.values()).map((slot) => ({
    version: slot.version,
    count: slot.count,
    avgScore: slot.count > 0 ? slot.scoreSum / slot.count : 0,
    lowScoreCount: slot.lowScoreCount,
    errorCount: slot.errorCount,
  })).sort((a, b) => b.count - a.count);

  const topIssues = Array.from(issueCounter.entries())
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
  const topSuggestions = Array.from(suggestionCounter.entries())
    .map(([suggestion, count]) => ({ suggestion, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return { promptVersions, topIssues, topSuggestions, totalConversations, totalReviews };
}

export interface AppendConversationMemoryInput {
  customerId: string;
  productId?: string;
  conversationId?: string;
  question: string;
  answer: string;
  sessionContext?: Record<string, string | number | boolean | null>;
  // 如果 answerQuestion 已经跑过 extractStructuredConversationFacts，把结果传过来可以省一次 LLM 调用
  preExtractedFacts?: {
    rentalPeriod?: RentalPeriod;
    productIntent?: ProductIntent;
  };
  // 意图分类器算出的 tag，会挂到用户消息上用于审计和 dashboard 回放
  userIntent?: import('./types.js').UserIntent;
}

export async function appendConversationMemory(input: AppendConversationMemoryInput) {
  return runWithMemoryLock(() => appendConversationMemoryInternal(input));
}

async function appendConversationMemoryInternal(input: AppendConversationMemoryInput) {
  const memoryMap = await readMemoryMap();
  const now = new Date().toISOString();
  const conversationKey = buildConversationId(input.customerId, input.productId, input.conversationId);

  const customerMemory: CustomerMemory = memoryMap[input.customerId] ?? {
    customerId: input.customerId,
    globalSummary: '',
    sessionContext: {},
    bodyProfiles: [],
    productMemories: {},
    updatedAt: now,
  };

  const extractedProfiles = extractProfilesFromInput({
    question: input.question,
    sessionContext: input.sessionContext,
    now,
  });

  customerMemory.sessionContext = {
    ...customerMemory.sessionContext,
    ...(input.sessionContext ?? {}),
  };
  customerMemory.bodyProfiles = mergeBodyProfiles(customerMemory.bodyProfiles ?? [], extractedProfiles);
  customerMemory.globalSummary = buildGlobalSummary(
    customerMemory.globalSummary,
    input.sessionContext,
    input.question,
    customerMemory.bodyProfiles,
  );

  const productMemory: ProductMemory = customerMemory.productMemories[conversationKey] ?? {
    productId: input.productId ?? 'general',
    conversationId: conversationKey,
    summary: '',
    recentMessages: [],
    conversationProfile: {
    reviews: [],
      updatedAt: now,
    },
    updatedAt: now,
  };

  productMemory.conversationProfile = mergeConversationProfile(
    productMemory.conversationProfile,
    await extractConversationProfile({
      question: input.question,
      sessionContext: input.sessionContext,
      now,
      existingProfile: productMemory.conversationProfile,
      preExtractedFacts: input.preExtractedFacts,
    }),
    now,
  );

  const handoffNeeded = input.sessionContext?.handoffNeeded === true;
  const handoffReason = typeof input.sessionContext?.handoffReason === 'string'
    ? input.sessionContext.handoffReason.trim()
    : '';
  const reviewStatus = typeof input.sessionContext?.reviewStatus === 'string'
    ? input.sessionContext.reviewStatus.trim()
    : '';
  const reviewSummary = typeof input.sessionContext?.reviewSummary === 'string'
    ? input.sessionContext.reviewSummary.trim()
    : '';
  const reviewFailureReason = typeof input.sessionContext?.reviewFailureReason === 'string'
    ? input.sessionContext.reviewFailureReason.trim()
    : '';

  // === 自动"翻转复核通过"：
  // 上一轮 orchestrator 已经把用户推到了 review_confirming（AI 发了商品/档期/尺码摘要），
  // 这一轮用户回了"好的/对的/没错/可以/没问题"之类 → 视为复核通过
  const prevStageWasReview =
    (productMemory.conversationProfile.orchestration?.stage === 'review_confirming');
  const userConfirmed = (() => {
    const t = (input.question ?? '').replace(/\s+/g, '').trim();
    return ['是', '是的', '对', '对的', '嗯', '嗯嗯', '好的', '好', '没错', '确认', '确认了', '可以', '没问题', '就这样'].includes(t);
  })();
  const currentReview = productMemory.conversationProfile.reviewCheck;
  const alreadyPassed = !!(currentReview?.completed && currentReview?.passed);
  if (!reviewStatus && prevStageWasReview && userConfirmed && !alreadyPassed) {
    productMemory.conversationProfile.reviewCheck = {
      needed: true,
      completed: true,
      passed: true,
      reviewedAt: now,
      source: 'system',
      summary: '用户已确认商品、档期、尺码等信息',
    };
  }

  if (reviewStatus) {
    const passed = reviewStatus === 'passed';
    const failed = reviewStatus === 'failed';
    productMemory.conversationProfile.reviewCheck = {
      needed: true,
      completed: passed || failed,
      passed,
      reviewedAt: passed || failed ? now : productMemory.conversationProfile.reviewCheck?.reviewedAt,
      source: 'manual',
      summary: reviewSummary || productMemory.conversationProfile.reviewCheck?.summary,
      failureReason: failed ? (reviewFailureReason || '复核未通过') : undefined,
    };
    if (failed) {
      productMemory.conversationProfile.handoffStatus = {
        needed: true,
        reason: reviewFailureReason || '复核未通过，需人工接管',
        createdAt: now,
        source: 'system',
      };
    }
  } else if (!productMemory.conversationProfile.reviewCheck) {
    productMemory.conversationProfile.reviewCheck = {
      needed: false,
      completed: false,
      passed: false,
      source: 'system',
    };
  }

  if (handoffNeeded || handoffReason) {
    productMemory.conversationProfile.handoffStatus = {
      needed: handoffNeeded,
      reason: handoffReason || undefined,
      createdAt: now,
      source: 'system',
    };
  } else if (input.sessionContext?.handoffNeeded === null) {
    productMemory.conversationProfile.handoffStatus = {
      needed: false,
      createdAt: now,
      source: 'system',
    };
  }

  const priceQuote = inferPriceQuote(input.productId, now) ?? productMemory.conversationProfile.priceQuote;
  const sizeRecommendation = inferSizeRecommendation(productMemory.conversationProfile, now);
  const availabilityCheck = await inferAvailabilityCheck(productMemory.conversationProfile, now, sizeRecommendation, input.productId);
  const orderReadiness = inferOrderReadiness(
    productMemory.conversationProfile,
    input.productId,
    now,
    sizeRecommendation,
    availabilityCheck,
  );
  const orchestration = deriveConversationOrchestration({
    profile: {
      ...productMemory.conversationProfile,
      priceQuote,
      sizeRecommendation,
      availabilityCheck,
      orderReadiness,
      updatedAt: now,
    },
    orderReadiness,
    productId: input.productId,
    now,
  });
  productMemory.conversationProfile = {
    ...productMemory.conversationProfile,
    priceQuote,
    sizeRecommendation,
    availabilityCheck,
    orderReadiness,
    orchestration,
    updatedAt: now,
  };
  if (productMemory.conversationProfile.orderPlacement?.orderNo) {
    productMemory.conversationProfile.orchestration = {
      ...productMemory.conversationProfile.orchestration,
      stage: 'post_order_followup',
      currentGoal: productMemory.conversationProfile.orderReadiness?.needReviewCheck ? '订单已提交，继续完成复核' : '跟进已下单客户',
      pendingSlots: productMemory.conversationProfile.orchestration?.pendingSlots ?? [],
      completedSlots: productMemory.conversationProfile.orchestration?.completedSlots ?? [],
      blockingIssues: productMemory.conversationProfile.orchestration?.blockingIssues ?? [],
      nextAction: productMemory.conversationProfile.orderReadiness?.needReviewCheck ? 'confirm_review' : 'close_loop',
      followUpQuestion: productMemory.conversationProfile.handoffStatus?.needed
        ? '这个物流时间我先帮您跟快递确认，确认好马上回您。'
        : productMemory.conversationProfile.orderReadiness?.needReviewCheck
          ? '订单这边已经接上了，我再和您把商品、档期、尺码这些信息核对一下。'
        : productMemory.conversationProfile.orchestration?.followUpQuestion,
      waitingForUser: true,
      paused: false,
      replyTemplateKey: productMemory.conversationProfile.orchestration?.replyTemplateKey ?? 'post_order_followup',
      shouldUseRag: productMemory.conversationProfile.orchestration?.shouldUseRag ?? true,
      shouldUseBusinessTools: productMemory.conversationProfile.orchestration?.shouldUseBusinessTools ?? true,
      handoffNeeded: productMemory.conversationProfile.handoffStatus?.needed ?? false,
      handoffReason: productMemory.conversationProfile.handoffStatus?.reason,
      updatedAt: now,
    };
  }
  productMemory.conversationProfile = updateProactiveFollowUpState({
    existingProfile: customerMemory.productMemories[conversationKey]?.conversationProfile,
    nextProfile: productMemory.conversationProfile,
    question: input.question,
    answer: input.answer,
    now,
  });

  productMemory.recentMessages = [
    ...productMemory.recentMessages,
    createMessage('user', input.question, now, input.userIntent ? { intent: input.userIntent } : undefined),
    createMessage('assistant', input.answer, now),
  ].slice(-MAX_RECENT_MESSAGES);

  if (!productMemory.reviews) productMemory.reviews = [];

  const conversationProfileSummary = buildConversationProfileSummary(productMemory.conversationProfile);
  productMemory.summary = [
    conversationProfileSummary ? `当前会话资料: ${conversationProfileSummary}` : '',
    buildProductSummary(productMemory.summary, productMemory.recentMessages),
  ]
    .filter(Boolean)
    .slice(-3)
    .join('\n');
  productMemory.updatedAt = now;

  customerMemory.productMemories[conversationKey] = productMemory;

  // 更新客户总体评分（在productMemory赋值后执行）
  const allReviews = Object.values(customerMemory.productMemories).flatMap(pm => pm.reviews || []);
  customerMemory.totalReviews = allReviews.length;
  customerMemory.overallRating = allReviews.length > 0 ? allReviews.reduce((sum, r) => sum + r.score, 0) / allReviews.length : undefined;

  customerMemory.updatedAt = now;
  memoryMap[input.customerId] = customerMemory;

  await writeMemoryMap(memoryMap);

  // 异步评估（fire-and-forget，走内部锁串行化，不影响 /chat 返回延迟）
  scheduleReview({
    customerId: input.customerId,
    productId: input.productId,
    conversationId: input.conversationId,
    evaluatedReply: input.answer,
    history: productMemory.recentMessages.slice(-10).map(({ role, content }) => ({ role, content })),
  });

  return {
    customerMemory,
    productMemory,
  };
}

function scheduleReview(input: {
  customerId: string;
  productId?: string;
  conversationId?: string;
  evaluatedReply: string;
  history: Array<{ role: string; content: string }>;
}) {
  void runWithMemoryLock(async () => {
    const timestamp = new Date().toISOString();
    let review: ProductMemory['reviews'][number];
    try {
      const evaluation = await evaluateCustomerServiceReply(input.history, input.evaluatedReply);
      review = {
        score: evaluation.score || 0,
        issues: evaluation.issues || [],
        suggestions: evaluation.suggestions || [],
        suggestedReply: evaluation.suggestedReply,
        timestamp,
        source: 'system',
        evaluatedReply: input.evaluatedReply,
        promptVersion: evaluation.promptVersion,
        chatModel: config.chatModel,
        evaluatorModel: evaluation.evaluatorModel,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('异步评估失败:', message);
      review = {
        score: 0,
        issues: ['评估调用失败'],
        suggestions: [],
        timestamp,
        source: 'system',
        evaluatedReply: input.evaluatedReply,
        promptVersion: loaded.promptVersion,
        chatModel: config.chatModel,
        evaluatorModel: config.evaluatorModel,
        error: message.slice(0, 500),
      };
    }

    const memoryMap = await readMemoryMap();
    const customer = memoryMap[input.customerId];
    if (!customer) return;
    const key = buildConversationId(input.customerId, input.productId, input.conversationId);
    const pm = customer.productMemories[key];
    if (!pm) return;
    if (!pm.reviews) pm.reviews = [];
    pm.reviews.push(review);

    const allReviews = Object.values(customer.productMemories).flatMap((p) => p.reviews || []);
    customer.totalReviews = allReviews.length;
    customer.overallRating = allReviews.length > 0
      ? allReviews.reduce((sum, r) => sum + r.score, 0) / allReviews.length
      : undefined;
    customer.updatedAt = timestamp;

    await writeMemoryMap(memoryMap);
  });
}

export async function addReview(input: { customerId: string; productId: string; rating: number; comment?: string }) {
  return runWithMemoryLock(() => addReviewInternal(input));
}

async function addReviewInternal(input: { customerId: string; productId: string; rating: number; comment?: string }) {
  const memoryMap = await readMemoryMap();
  const customer = memoryMap[input.customerId];
  if (!customer) return;
  const productMem = customer.productMemories[input.productId];
  if (!productMem) return;
  const review = {
    score: input.rating,
    issues: [],
    suggestions: input.comment ? [input.comment] : [],
    timestamp: new Date().toISOString(),
    source: "user" as const,
  };
  if (!productMem.reviews) productMem.reviews = [];
  productMem.reviews.push(review);

  // 更新总体评分
  const allReviews = Object.values(customer.productMemories).flatMap(pm => pm.reviews || []);
  customer.totalReviews = allReviews.length;
  customer.overallRating = allReviews.length > 0 ? allReviews.reduce((sum, r) => sum + r.score, 0) / allReviews.length : undefined;

  await writeMemoryMap(memoryMap);
}

export async function reEvaluateConversation(input: { customerId: string; productId?: string; conversationId?: string }) {
  return runWithMemoryLock(() => reEvaluateConversationInternal(input));
}

async function reEvaluateConversationInternal(input: { customerId: string; productId?: string; conversationId?: string }) {
  const memoryMap = await readMemoryMap();
  const customerMemory = memoryMap[input.customerId];
  if (!customerMemory) {
    throw new Error('未找到该客户记忆');
  }

  const conversationKey = buildConversationId(input.customerId, input.productId, input.conversationId);
  const productMemory = customerMemory.productMemories[conversationKey];
  if (!productMemory) {
    throw new Error('未找到该产品会话记忆');
  }

  const assistantReply = [...productMemory.recentMessages].reverse().find((message) => message.role === 'assistant');
  if (!assistantReply) {
    throw new Error('当前会话没有可评估的客服回复');
  }

  productMemory.reviews = (productMemory.reviews || []).filter((review) => !isInvalidSystemReview(review));

  const latestSystemReview = [...productMemory.reviews].reverse().find(
    (review) => review.source === 'system' && review.evaluatedReply === assistantReply.content,
  );

  if (latestSystemReview) {
    return {
      ok: true,
      updated: false,
      review: latestSystemReview,
    };
  }

  const evaluation = await evaluateCustomerServiceReply(
    productMemory.recentMessages.map(({ role, content }) => ({ role, content })),
    assistantReply.content,
  );

  const review = {
    score: evaluation.score || 0,
    issues: evaluation.issues || [],
    suggestions: evaluation.suggestions || [],
    suggestedReply: evaluation.suggestedReply,
    timestamp: new Date().toISOString(),
    source: 'system' as const,
    evaluatedReply: assistantReply.content,
    promptVersion: evaluation.promptVersion,
    chatModel: config.chatModel,
    evaluatorModel: evaluation.evaluatorModel,
  };

  if (!productMemory.reviews) productMemory.reviews = [];
  productMemory.reviews.push(review);

  const allReviews = Object.values(customerMemory.productMemories).flatMap((pm) => pm.reviews || []);
  customerMemory.totalReviews = allReviews.length;
  customerMemory.overallRating = allReviews.length > 0 ? allReviews.reduce((sum, r) => sum + r.score, 0) / allReviews.length : undefined;
  customerMemory.updatedAt = new Date().toISOString();

  memoryMap[input.customerId] = customerMemory;
  await writeMemoryMap(memoryMap);

  return {
    ok: true,
    updated: true,
    review,
  };
}
