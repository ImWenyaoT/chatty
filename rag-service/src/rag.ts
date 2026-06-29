// 薄控制器：
//   answerQuestion() = 拉上下文 → selectAction → renderAction → 返回
//
// 旧版本的大量 build*Reply helper 已经搬进 src/rag/templates.ts，
// 大量 isXxxQuestion 判别已经搬进 src/rag/intents.ts，
// 选 Action 的规则 + LLM tool-call 兜底在 src/rag/action-picker.ts。

import { config } from './config.js';
import { cosineSimilarity, readLocalVectors } from './local-store.js';
import { extractStructuredConversationFacts, getCustomerMemory, getProductMemory } from './memory-store.js';
import { openai } from './openai.js';
import {
  buildCurrentMonthDate,
  buildCurrentYearMonthDate,
  normalizeDateText,
} from './parsers/date.js';
import { extractHeightWeightFromText, extractQuantityFromText } from './parsers/measurements.js';
import { loaded, renderTemplate } from './prompts-loader.js';
import { isQdrantAvailable, qdrant } from './qdrant.js';
import { selectAction, type ActionContext } from './rag/action-picker.js';
import { generateText } from './rag/generate-text.js';
import { classifyUserIntent, intentToExtractionPolicy } from './rag/intent-classifier.js';
import { ChatRequestBody, IntentClassification, KnowledgeChunk } from './types.js';

// ========== 文本清洗 ==========
function sanitizeAnswerText(text: string) {
  return text
    // 去掉 Markdown 图片语法 ![alt](url)——图片走独立的 imageReferences 卡片展示，
    // 文本里留着会让客户看到一串 "/media/xxx.jpg" 的原始路径，像暴露了后台。
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // 去掉普通 Markdown 链接 [text](url) 中的 url，保留 text——链接在聊天里没意义
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
    .replace(/\*/g, '')
    // 清掉图片去除后遗留的多余空行
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([，。！？])/g, '$1')
    .replace(/([，。！？]){2,}/g, '$1')
    .trim();
}

// ========== 用户本轮的身高体重抽取 ==========
function extractProvidedBody(question: string) {
  const { heightCm, weightKg, inferredWeightUnit } = extractHeightWeightFromText(question);
  if (heightCm === undefined && weightKg === undefined) return undefined;
  const isUpdating = /修改|改下|改成|更新|重新记|重记|改一下/.test(question);
  return { heightCm, weightKg, isUpdating, inferredUnit: inferredWeightUnit };
}

// ========== 用户本轮的件数抽取 ==========
function extractProvidedQuantity(question: string) {
  const count = extractQuantityFromText(question);
  if (count === undefined) return undefined;
  const isUpdating = /改成|改为|改下|更新|调整|改一下|改回/.test(question);
  return { count, isUpdating };
}

// ========== 用户本轮的档期抽取（仅作为兜底，主路径走 extractStructuredConversationFacts） ==========
function extractProvidedPeriodFallback(questionRaw: string) {
  // 关键：压掉所有空白。用户可能打成 "5 月 10 号" "5 月10号" 之类，regex 都能命中
  const question = questionRaw.replace(/\s+/g, '');
  const monthDay = question.match(/([0-9]{1,2})月([0-9]{1,2})(?:日|号)?/);
  if (monthDay) {
    const date = buildCurrentYearMonthDate(Number(monthDay[1]), Number(monthDay[2]));
    const range = question.match(/([0-9]{1,2})月([0-9]{1,2})(?:日|号)?(?:到|至|~|—|-|--|－)([0-9]{1,2})月([0-9]{1,2})(?:日|号)?/);
    if (range) {
      return {
        startDate: buildCurrentYearMonthDate(Number(range[1]), Number(range[2])),
        endDate: buildCurrentYearMonthDate(Number(range[3]), Number(range[4])),
        isUpdating: /修改|改下|改成|改为|更新|调整/.test(question),
      };
    }
    // 同月跨日：「5月9号到10号」第二段省略月份，结束日沿用开始月份
    const sameMonthRange = question.match(/([0-9]{1,2})月([0-9]{1,2})(?:日|号)?(?:到|至|~|—|-|--|－)([0-9]{1,2})(?:日|号)?/);
    if (sameMonthRange) {
      const m = Number(sameMonthRange[1]);
      const d1 = Number(sameMonthRange[2]);
      const d2 = Number(sameMonthRange[3]);
      if (d2 >= d1) {
        return {
          startDate: buildCurrentYearMonthDate(m, d1),
          endDate: buildCurrentYearMonthDate(m, d2),
          isUpdating: /修改|改下|改成|改为|更新|调整/.test(question),
        };
      }
    }
    return { startDate: date, endDate: date, isUpdating: /修改|改下|改成|改为|更新|调整/.test(question) };
  }
  const dayOnly = question.match(/([0-9]{1,2})(?:日|号)(?:用|穿|租|要用|需要|开始|当天)?/);
  if (dayOnly) {
    const d = buildCurrentMonthDate(Number(dayOnly[1]));
    return { startDate: d, endDate: d, isUpdating: /修改|改下|改成|改为|更新|调整/.test(question) };
  }
  return undefined;
}

// ========== 知识检索 ==========
function toKnowledgeChunk(payload: Record<string, unknown> | null | undefined): KnowledgeChunk {
  return {
    id: String(payload?.id ?? ''),
    text: String(payload?.text ?? ''),
    sourceType: (payload?.sourceType as KnowledgeChunk['sourceType']) ?? 'rule',
    contentType: (payload?.contentType as KnowledgeChunk['contentType']) ?? 'text',
    filePath: String(payload?.filePath ?? ''),
    title: String(payload?.title ?? ''),
    chunkIndex: Number(payload?.chunkIndex ?? 0),
  };
}

export async function embedText(input: string) {
  const response = await openai.embeddings.create({
    model: config.embeddingModel,
    input,
  });
  return response.data[0].embedding;
}

// 进程级标记：一旦确认 embedding 接口不存在（HTTP 404），后续不再发起无谓请求。
// 典型场景：所连的 OpenAI 兼容后端（如 DeepSeek）只提供 chat completions、不提供 embeddings。
let embeddingEndpointMissing = false;

/**
 * 检索知识库：优先 Qdrant 向量检索，无 Qdrant 时退回本地向量库。
 * embedding 不可用时做显式降级——warn 一次并返回空结果，让上层走"无知识上下文"分支，
 * 而不是让整条问答链路崩溃。注意这是有声降级（会打 warn），不是沉默吞错。
 */
export async function searchKnowledge(question: string) {
  if (embeddingEndpointMissing) return [];
  let vector: number[];
  try {
    vector = await embedText(question);
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: number }).status
        : undefined;
    if (status === 404) embeddingEndpointMissing = true;
    console.warn(
      '[searchKnowledge] embedding 调用失败，本次跳过知识检索：',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
  if (await isQdrantAvailable()) {
    const result = await qdrant.search(config.qdrantCollection, {
      vector,
      limit: config.topK,
      with_payload: true,
    });
    return result.map((item) => ({
      score: item.score,
      payload: toKnowledgeChunk((item.payload ?? null) as Record<string, unknown> | null),
    }));
  }
  const localVectors = await readLocalVectors();
  return localVectors
    .map((point) => ({
      score: cosineSimilarity(vector, point.vector),
      payload: point.payload,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, config.topK);
}

// ========== 主入口 ==========
export async function answerQuestion(body: ChatRequestBody) {
  const customerMemory = await getCustomerMemory(body.customerId);
  const productMemory = await getProductMemory(body.customerId, body.productId, body.conversationId);

  // === 步骤 0：意图分类（独立一层，LLM + 关键词 fast-path + keyword fallback）===
  // 下游所有模块（事实抽取、产品锁定、图片引用判断）都统一读这个 intent
  const lastAssistantMessage = productMemory?.recentMessages
    ?.slice()
    .reverse()
    .find((message) => message.role === 'assistant')?.content;
  const intentClassification: IntentClassification = await classifyUserIntent({
    question: body.question ?? '',
    profile: productMemory?.conversationProfile,
    recentMessages: productMemory?.recentMessages,
    lastAssistantMessage,
  });
  const extractionPolicy = intentToExtractionPolicy(intentClassification.intent);

  // 用户发了图片 → vision 识别成一段文字描述，并入检索 query
  let userImageCaption: string | undefined;
  let effectiveQuestion = body.question?.trim() || '';
  if (body.imageUrl) {
    try {
      const { describeImage } = await import('./vision.js');
      userImageCaption = await describeImage({
        imageUrl: body.imageUrl,
        productId: body.productId,
        mode: 'query',
      });
      effectiveQuestion = [effectiveQuestion, `[用户发来图片] ${userImageCaption}`]
        .filter(Boolean)
        .join(' ');
    } catch (error) {
      console.warn('[answerQuestion] vision caption failed:', error instanceof Error ? error.message : error);
    }
  }
  if (!effectiveQuestion) {
    effectiveQuestion = body.imageUrl ? '[图片]' : '';
  }
  const rawReferences = await searchKnowledge(effectiveQuestion);

  // ========== 图片过滤：按用户意图剔除不相关的图片 chunk ==========
  // 三层过滤互为保险：
  //   A. 商品 ID 精确匹配（用户明说 SUIT-002 就不该混入 SUIT-003）
  //   B. 图片类型（用户要款式图时不该混入尺码表图）
  //   C. 后面 imageReferences 的分数门控
  const userTextForImage = body.question?.trim() ?? '';

  // A. 商品 ID 精确匹配：用户消息里显式出现的商品 ID，其他商品的图要剔除
  const mentionedProductIds = Array.from(
    userTextForImage.matchAll(/\bSUIT[-_]?\d+\b/gi),
  ).map((m) => m[0].toUpperCase().replace(/[_]/g, '-'));
  const belongsToMentionedProduct = (captionOrTitle: string | undefined): boolean => {
    if (mentionedProductIds.length === 0) return true; // 用户没点名 → 不过滤
    if (!captionOrTitle) return false;
    const normalized = captionOrTitle.toUpperCase().replace(/[_\s]/g, '-');
    return mentionedProductIds.some((id) => normalized.includes(id));
  };

  // B. 图片类型识别：size_chart vs style
  const SIZE_CHART_CAPTION = /尺码|size\s*chart|价目|价格表|价位|对照表/i;
  const classifyImage = (caption: string | undefined): 'size_chart' | 'style' =>
    caption && SIZE_CHART_CAPTION.test(caption) ? 'size_chart' : 'style';
  const wantsSizeChart = /尺码表|尺码图|尺码信息|尺码对照|size\s*chart|价目表|价格表/i.test(userTextForImage);
  const wantsStyleOnly =
    !wantsSizeChart &&
    /款式|效果图|实拍|上身|模特|外观|正面|背面|细节图|样图|样式|照片|成品图/.test(userTextForImage);

  const references = rawReferences.filter((item) => {
    if (item.payload.contentType !== 'image') return true;
    const captionOrTitle = item.payload.caption ?? item.payload.title;
    // A. 商品 ID 不匹配直接剔除
    if (!belongsToMentionedProduct(captionOrTitle)) return false;
    // B. 图片类型不符也剔除
    const kind = classifyImage(captionOrTitle);
    if (wantsStyleOnly) return kind === 'style';
    if (wantsSizeChart) return kind === 'size_chart';
    return true;
  });

  const bodyProfiles = customerMemory?.bodyProfiles ?? [];
  const conversationProfile = productMemory?.conversationProfile;

  // 身高体重/档期是确定性可解析的信号，与 intent 正交：本句只要确定性命中就放行抽取，
  // 避免单意图（如 select_product）把同一句里一并给出的体型/档期丢弃（all-in-one 一句话给全）。
  const allowBody = extractionPolicy.allowBody || /身高|体重|cm|kg|公斤|斤/i.test(body.question);
  const allowPeriod = extractionPolicy.allowPeriod || /[0-9]{1,2}\s*月|[0-9]{1,2}\s*[日号]/.test(body.question);

  // 只在允许抽体型时才从当前消息解析身高/体重
  const providedBody = allowBody ? extractProvidedBody(body.question) : undefined;
  // 件数：和 body / period 一样都属于"客户主动给信息"，沿用同样的 gate（属于客户陈述事实）
  const providedQuantity = allowBody || allowPeriod
    ? extractProvidedQuantity(body.question)
    : undefined;

  const nowIso = new Date().toISOString();
  // 意图或确定性信号允许就调 LLM 抽事实
  const needsLLMFactExtract =
    (extractionPolicy.allowProductIntent || allowPeriod) &&
    /[0-9]|月|日|号|想租|想要|要租|换成|改成|想换成|意向|款式|商品|年/.test(body.question);
  const structuredFacts = needsLLMFactExtract
    ? await extractStructuredConversationFacts({
        question: body.question,
        existingProfile: conversationProfile,
        now: nowIso,
        extractionPolicy,
      })
    : { rentalPeriod: undefined, productIntent: undefined };
  // 融合 LLM 和正则 fallback：LLM 优先，缺字段正则补；最后单日租赁自动补 endDate=startDate
  const fallbackPeriod = allowPeriod ? extractProvidedPeriodFallback(body.question) : undefined;
  const llmStart = structuredFacts.rentalPeriod?.startDate;
  const llmEnd = structuredFacts.rentalPeriod?.endDate;
  const mergedStart = llmStart ?? fallbackPeriod?.startDate;
  const mergedEnd = llmEnd ?? fallbackPeriod?.endDate ?? mergedStart;
  const providedPeriod = (mergedStart || mergedEnd)
    ? {
        startDate: mergedStart,
        endDate: mergedEnd,
        isUpdating: /修改|改下|改成|改为|更新|调整/.test(body.question),
      }
    : undefined;

  // 只有当 intent 允许切换商品时才吃本轮新抽取出来的 productText；
  // 否则即便 LLM 抽出了什么，也不覆盖已有商品（解决"发我所有款式图片"污染商品栏的问题）
  const productTextFromFacts = extractionPolicy.allowProductIntent
    ? structuredFacts.productIntent?.currentProductText
    : undefined;
  const productTextExisting = conversationProfile?.productIntent?.currentProductText;
  const defaultProductText = typeof body.sessionContext?.defaultProductText === 'string'
    ? body.sessionContext.defaultProductText.trim()
    : undefined;
  const effectiveProductText = productTextFromFacts ?? productTextExisting ?? defaultProductText;

  const ctx: ActionContext = {
    question: effectiveQuestion || body.question,
    productId: body.productId,
    conversationProfile,
    bodyProfilesLabels: bodyProfiles.map((p) => p.label).filter(Boolean),
    bodyProfilesCount: bodyProfiles.length,
    lastAssistantMessage,
    effectiveProductText,
    references,
    recentMessages: productMemory?.recentMessages,
    providedBody,
    providedPeriod,
    providedQuantity,
  };

  const action = await selectAction(ctx);
  // LLM 生成文本（带 Action-scoped 约束 + 上下文），失败自动回退到 renderAction 模板
  const { text: rawAnswer, source: answerSource } = await generateText(action, ctx);
  const answer = sanitizeAnswerText(rawAnswer);

  const mappedReferences = references.map((item) => ({
    score: item.score,
    sourceType: item.payload.sourceType,
    contentType: item.payload.contentType,
    title: item.payload.title,
    filePath: item.payload.filePath,
    chunkIndex: item.payload.chunkIndex,
    text: item.payload.text,
    ...(item.payload.imageUrl ? { imageUrl: item.payload.imageUrl } : {}),
    ...(item.payload.caption ? { caption: item.payload.caption } : {}),
  }));

  // ========== 图片引用的相关性门控 ==========
  // 不是每次回答都应该附图。只在以下情况附图：
  //   1) 用户本轮上传了图片（说明明显在问图）
  //   2) 或者用户文本里有图片意图关键词，且 top 图片分数 >= 0.4
  //   3) 或者 top 图片分数非常高（>= 0.55），强信号优先
  // 否则一个"在吗"/"你好"的小谈话也会挂出一堆商品图，非常违和
  // references 已按图片类型做过意图过滤，这里只做"是否要附图"的门控
  const userText = body.question?.trim() ?? '';
  const hasImageIntent = /图|照片|照一张|图片|示意|样式|看[一下看]?|发我|上身|效果图|细节|尺码表|吊牌|搭配|样图/.test(
    userText,
  );
  const userSentImage = Boolean(body.imageUrl);
  const SMALL_TALK = /^(在[吗么]?|您?好|你好|哈喽|hi|hello|hey|谢谢|感谢|嗯|哦|好的|辛苦)[\s!?？。！]*$/i;
  const isSmallTalk = SMALL_TALK.test(userText);
  const imageCandidates = mappedReferences
    .filter((r) => r.contentType === 'image' && r.imageUrl)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const topImageScore = imageCandidates[0]?.score ?? 0;
  const shouldShowImages =
    !isSmallTalk &&
    (userSentImage ||
      (hasImageIntent && topImageScore >= 0.4) ||
      topImageScore >= 0.55);
  const imageReferences = shouldShowImages
    ? imageCandidates
        // 再做一次每张图的分数过滤：即使 top 达标，也别把 0.3 的凑数拉出来
        .filter((r) => (r.score ?? 0) >= Math.max(0.4, topImageScore - 0.25))
        .slice(0, 3)
        .map((r) => ({
          score: r.score,
          imageUrl: r.imageUrl!,
          caption: r.caption ?? r.title,
          title: r.title,
        }))
    : [];

  const handoff = action.kind === 'handoff'
    ? { needed: true, reason: action.reason }
    : (action.kind === 'post_order_delivery' && action.needsHandoff
        ? { needed: true, reason: action.handoffReason || '下单后物流时间需人工确认' }
        : undefined);

  return {
    answer,
    references: mappedReferences,
    imageReferences,         // 已按意图+分数门控过滤的图片引用（可能为空）
    action: action.kind,
    answerSource,            // 'llm' | 'fallback'，供 dashboard 观察回退率
    handoff,
    userImageCaption,        // 用户如果发了图，这里是 vision 模型给出的描述
    intent: intentClassification, // 统一的意图分类结果（dashboard 可展示）
    // 透传给 appendConversationMemory 避免第二次 LLM 事实抽取
    extractedFacts: structuredFacts,
  };
}

// ========== 评估器（保持原接口） ==========
function extractJsonFromText(text: string) {
  const start = text.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escape) { escape = false; continue; }
    if (char === '\\') { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function normalizeArrayText(raw: string): string[] {
  return raw
    .split(/\r?\n|；|;|，|,|、|\t/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^[-*\d\.\s]*\s*/, '').trim());
}

function parseJsonArrayValue(rawText: string, key: string) {
  const regex = new RegExp(`['\"]?${key}['\"]?\\s*:\\s*(\\[[\\s\\S]*?\\])`, 'i');
  const match = rawText.match(regex);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return normalizeArrayText(match[1].replace(/^\[|\]$/g, ''));
  }
}

function parseLooseEvaluation(rawText: string) {
  const normalized = rawText
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .replace(/“|”/g, '"')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const scoreMatch = normalized.match(/(?:score|评分)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const issuesMatch = normalized.match(/(?:issues|问题)\s*[:：]?\s*([\s\S]*?)(?:\n\s*(?:suggestions|建议)\s*[:：]?|$)/i);
  const suggestionsMatch = normalized.match(/(?:suggestions|建议)\s*[:：]?\s*([\s\S]*?)(?:$)/i);

  const score = scoreMatch ? Number(scoreMatch[1]) : 0;
  const issues = issuesMatch
    ? normalizeArrayText(issuesMatch[1]).slice(0, 3)
    : parseJsonArrayValue(normalized, 'issues').slice(0, 3);
  const suggestions = suggestionsMatch
    ? normalizeArrayText(suggestionsMatch[1]).slice(0, 3)
    : parseJsonArrayValue(normalized, 'suggestions').slice(0, 3);

  return {
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 0,
    issues,
    suggestions,
  };
}

export interface EvaluationResult {
  score: number;
  issues: string[];
  suggestions: string[];
  suggestedReply?: string;
  evaluatorModel: string;
  promptVersion: string;
}

export async function evaluateCustomerServiceReply(
  conversationHistory: Array<{ role: string; content: string }>,
  customerServiceReply: string,
): Promise<EvaluationResult> {
  const historyText = conversationHistory
    .map((message) => `${message.role === 'user' ? '用户' : '客服'}: ${message.content}`)
    .join('\n');

  const userPrompt = renderTemplate(loaded.prompts.evaluatorUserTemplate, {
    historyText,
    customerServiceReply,
  });

  const completion = await openai.chat.completions.create({
    model: config.evaluatorModel,
    temperature: 0.0,
    top_p: 1,
    max_tokens: 800,
    // DeepSeek 等 OpenAI 兼容后端不支持 json_schema structured outputs，统一用 json_object（JSON mode），
    // OpenAI 同样支持。解析端已用 extractJsonFromText + parseLooseEvaluation 兜底，不依赖 schema 强校验；
    // 字段结构由 evaluator 的 system/user 模板用文字约定。注意 json_object 模式要求 prompt 含 "json" 字样（已满足）。
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: loaded.prompts.evaluatorSystemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const rawText = completion.choices[0]?.message?.content ?? '';
  const jsonText = extractJsonFromText(rawText.trim());
  const baseMeta = { evaluatorModel: config.evaluatorModel, promptVersion: loaded.promptVersion };

  try {
    const parsed = JSON.parse(jsonText) as {
      score?: number;
      issues?: string[];
      suggestions?: string[];
      suggestedReply?: string;
    };
    const score = parsed.score != null ? Math.min(10, Math.max(1, Number(parsed.score))) : 0;
    const issues = Array.isArray(parsed.issues) ? parsed.issues.map((item) => String(item)).slice(0, 3) : [];
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.map((item) => String(item)).slice(0, 3) : [];
    const suggestedReply = typeof parsed.suggestedReply === 'string' ? parsed.suggestedReply.trim() || undefined : undefined;

    if (score === 0) {
      throw new Error(`无效评分结果，rawText: ${rawText.slice(0, 500)}`);
    }

    return { score, issues, suggestions, suggestedReply, ...baseMeta };
  } catch (error) {
    console.error('评价解析失败:', error, 'rawText:', rawText);
    const fallback = parseLooseEvaluation(rawText);
    if (fallback.score === 0) {
      throw new Error(`评价解析失败且无法从原始输出恢复有效评分，rawText: ${rawText.slice(0, 500)}`);
    }
    return { ...fallback, ...baseMeta };
  }
}

// 向后兼容（暂时保留给其它可能用到的引用）
export function _sanitizeAnswerText(text: string) {
  return sanitizeAnswerText(text);
}
