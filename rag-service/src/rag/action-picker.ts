// selectAction(ctx): 从请求上下文算出这一轮该回的 Action。
// 两阶段：(1) 确定性 fast-path 规则；(2) LLM tool-call 分类器兜底。

import { config } from '../config.js';
import { deriveConversationOrchestration } from '../conversation-orchestrator.js';
import { findProduct, pickSizeByMeasurement } from '../prompts-loader.js';
import { createFunctionCall } from '../responses.js';
import type { ConversationProfile, KnowledgeChunk, MemoryMessage } from '../types.js';
import type { Action } from './actions.js';
import {
  isBodyMeasurementRecallQuestion,
  isCatalogListQuestion,
  isCurrentLinkProductQuestion,
  isMediaRequestQuestion,
  isDeliveryQuestion,
  isGenericRentIntent,
  isGreetingQuestion,
  isOrderQuestion,
  isPendingBodyMeasurementConfirmation,
  isPendingRentalPeriodConfirmation,
  isPriceQuestion,
  isRentalHowToQuestion,
  isRepairQuestion,
  isSimpleConfirmation,
  isSizeQuestion,
} from './intents.js';

export interface ActionContext {
  question: string;
  productId?: string;
  conversationProfile?: ConversationProfile;
  bodyProfilesLabels: string[];
  bodyProfilesCount: number;
  lastAssistantMessage?: string;
  effectiveProductText?: string;
  references: Array<{ score: number; payload: KnowledgeChunk }>;
  // 最近几轮对话消息（给 generateText 的 LLM 用）
  recentMessages?: MemoryMessage[];
  // 用户本轮消息里抽到的结构化事实
  providedBody?: { heightCm?: number; weightKg?: number; isUpdating: boolean; inferredUnit?: 'kg' | 'jin' };
  providedPeriod?: { startDate?: string; endDate?: string; isUpdating: boolean };
  providedQuantity?: { count: number; isUpdating: boolean };
}

// 判断下单后物流问题是否需要转人工。开始使用日期距今 <2 天 → 人工跟进，因为常规"前一天寄到"已来不及
function evaluateDeliveryUrgency(rentalStartDate?: string): { needsHandoff: boolean; handoffReason?: string } {
  if (!rentalStartDate) return { needsHandoff: false };
  const match = rentalStartDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return { needsHandoff: false };
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(start.getTime())) return { needsHandoff: false };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((start.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 2) {
    return {
      needsHandoff: true,
      handoffReason: `客户已下单，租赁开始时间 ${rentalStartDate} 较近，需人工确认物流时效。`,
    };
  }
  return { needsHandoff: false };
}

// 对 profile 做一次"假设本轮用户提供的事实已经写入"的推演，跑一次 orchestrator
// 这样当用户一口气把身高体重/档期给全时，这一轮就能直接走 guide_order/confirm_review
function deriveNextProfile(ctx: ActionContext): ConversationProfile {
  const now = new Date().toISOString();
  const existing = ctx.conversationProfile;

  const heightCm = ctx.providedBody?.heightCm ?? existing?.heightCm;
  const weightKg = ctx.providedBody?.weightKg ?? existing?.weightKg;
  const rentalPeriod = ctx.providedPeriod
    ? {
        startDate: ctx.providedPeriod.startDate ?? existing?.rentalPeriod?.startDate,
        endDate: ctx.providedPeriod.endDate ?? existing?.rentalPeriod?.endDate,
        source: existing?.rentalPeriod?.source ?? ('message' as const),
        lastMentionedAt: existing?.rentalPeriod?.lastMentionedAt ?? now,
      }
    : existing?.rentalPeriod;
  const productIntent = ctx.effectiveProductText
    ? {
        currentProductText: ctx.effectiveProductText,
        source: existing?.productIntent?.source ?? ('message' as const),
        lastMentionedAt: existing?.productIntent?.lastMentionedAt ?? now,
      }
    : existing?.productIntent;

  // 数量：本轮指定 > 已有显式值 > 默认 1（默认值不计为"显式"）
  const existingQty = existing?.quantity;
  const providedQty = ctx.providedQuantity?.count;
  const quantity = providedQty !== undefined
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
        };

  const sizeRec = heightCm !== undefined && weightKg !== undefined
    ? pickSizeByMeasurement(heightCm, weightKg)
    : undefined;

  const hasProduct = !!(productIntent?.currentProductText || ctx.productId);
  const hasPeriod = !!(rentalPeriod?.startDate && rentalPeriod?.endDate);
  const hasBody = heightCm !== undefined && weightKg !== undefined;

  // 推断 availabilityCheck：三项齐全 + 有尺码建议 → 乐观认为档期可用
  // 复用已存在的 availabilityCheck.availableSize（如果用户之前已经核过档期库存就别丢）
  const existingCheck = existing?.availabilityCheck;
  const existingAvailableSize = existingCheck?.availableSize;
  const effectiveSize = existingAvailableSize ?? sizeRec?.size;
  // 注意："尺码待人工确认"也算有效——虽然精确尺码待人工复核，但客服可以先带用户走完复核+下单流程，
  // 否则尺码一兜底立即卡死，永远到不了 review_confirming / order_guiding
  const hasValidSize = !!effectiveSize;
  const canCompleteAvailability = hasProduct && hasPeriod && hasBody && hasValidSize;

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
    : existingCheck;

  // === 复核阶段状态推演 ===
  // 条件齐了之后必须过一遍"复核"——先向用户朗读 商品/档期/尺码 摘要，
  // 用户确认（好的/对的/没错）才算 reviewCheck.passed=true，然后才能 guide_order
  const existingReview = existing?.reviewCheck;
  const reviewAlreadyPassed = !!(existingReview?.completed && existingReview?.passed);
  const prereqsOk = hasProduct && hasPeriod && hasBody && hasValidSize && canCompleteAvailability;
  const lastStage = existing?.orchestration?.stage;
  const userConfirmedNow =
    prereqsOk && !reviewAlreadyPassed && lastStage === 'review_confirming' && isSimpleConfirmation(ctx.question);

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
        : existingReview;
  const reviewDone = !!(reviewCheck?.completed && reviewCheck?.passed);

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
  };

  const next: ConversationProfile = {
    ...existing,
    heightCm,
    weightKg,
    rentalPeriod,
    productIntent,
    quantity,
    sizeRecommendation: sizeRec
      ? { recommendedSize: sizeRec.size, confidence: sizeRec.confidence, source: 'rule' as const, lastRecommendedAt: now }
      : existing?.sizeRecommendation,
    availabilityCheck,
    reviewCheck,
    orderReadiness,
    updatedAt: now,
  };

  next.orchestration = deriveConversationOrchestration({
    profile: next,
    orderReadiness,
    productId: ctx.productId,
    now,
  });

  return next;
}

// ========== LLM 分类器 ==========

const classifierSystemPrompt = `你是客服决策器，不输出自然语言回复，只调用 decide_reply 函数。

四种模式的判断标准：
- follow_flow: 用户在按正常流程推进（提供身高/体重/档期/款式、问尺码、问档期、要下单等）。大部分消息都选这个。
- answer_faq: 用户问了一个事实性问题，需要根据检索知识回答。包括：
  · 店铺信息（店铺名、电话、营业时间、退换政策、物流规则等）；
  · **商品目录类询问**（"有哪些款式 / 都有什么款 / 有几款 / 都卖什么" 等），必须从"检索到的知识"中摘出商品名/编号**列出**来（最多 3-5 个），不要追问档期、身高体重。
  faqAnswer 里必须给出 1-3 句直接回答，不要追问围度/常穿码/三围，不要问拆件。
- small_talk: 用户说了很短的非业务话（谢谢/辛苦了/哈哈/emoji），smallTalkText 给 3-10 字的自然回应即可。
- handoff: 用户明确要找人工、投诉、要退款/赔偿/特殊处理。handoffReason 写触发原因。

约束：
1. 如果上下文里"身高体重"、"档期"、"款式"这三项已经齐全，必须选 follow_flow（后续模板会自动给推荐尺码 + 引导下单）。
2. answer_faq 模式下，永远不问胸围/腰围/肩宽/常穿码/几 XL/软尺。
3. 不输出除 decide_reply 调用外的任何内容。`;

interface ClassifierResult {
  mode: 'follow_flow' | 'answer_faq' | 'small_talk' | 'handoff';
  faqAnswer?: string;
  smallTalkText?: string;
  handoffReason?: string;
}

async function callClassifier(ctx: ActionContext): Promise<ClassifierResult> {
  // 图片 chunk 的 text 里包含 `Markdown: ![caption](/media/xxx.jpg)` 一行，
  // LLM 看到会把这行原样复制进 faqAnswer，客户就看到 /media/ 路径像暴露后台。
  // 这里剥掉它——图片由前端 imageReferences 独立渲染，不需要 LLM 在文本里粘链接。
  const stripMarkdownImageLine = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !/^\s*(Markdown\s*:\s*)?!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
      .filter((line) => !/^\s*图片链接\s*:/.test(line))
      .join('\n');
  const referencesText = ctx.references
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.payload.title}\n${stripMarkdownImageLine(r.payload.text)}`)
    .join('\n\n');

  const profile = ctx.conversationProfile;
  const stageLines = [
    profile?.heightCm !== undefined ? `身高: ${profile.heightCm}cm` : '',
    profile?.weightKg !== undefined ? `体重: ${profile.weightKg}kg` : '',
    profile?.rentalPeriod?.startDate ? `档期: ${profile.rentalPeriod.startDate} 到 ${profile.rentalPeriod.endDate ?? '?'}` : '',
    ctx.effectiveProductText ? `款式: ${ctx.effectiveProductText}` : '',
    profile?.orchestration?.stage ? `当前阶段: ${profile.orchestration.stage}` : '',
  ].filter(Boolean).join('\n');

  const userContent = `用户这句话：\n${ctx.question}\n\n上下文：\n${stageLines || '（空）'}\n\n检索到的知识：\n${referencesText || '（无命中）'}`;

  const parsed = await createFunctionCall<ClassifierResult>({
    model: config.chatModel,
    temperature: 0.1,
    instructions: classifierSystemPrompt,
    input: [{ role: 'user', content: userContent }],
    tool: {
      type: 'function',
      name: 'decide_reply',
      description: '决定当前客服回复的模式',
      strict: false,
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['follow_flow', 'answer_faq', 'small_talk', 'handoff'],
          },
          faqAnswer: { type: 'string', description: '当 mode=answer_faq 时填。1-3 句直接回答，不得追问围度/常穿码/拆件。' },
          smallTalkText: { type: 'string', description: '当 mode=small_talk 时填。3-10 字自然回应。' },
          handoffReason: { type: 'string', description: '当 mode=handoff 时填。' },
        },
        required: ['mode'],
      },
    },
  });

  if (!parsed) {
    return { mode: 'follow_flow' };
  }
  return parsed;
}

// ========== 主入口 ==========

export async function selectAction(ctx: ActionContext): Promise<Action> {
  const q = ctx.question;
  const profile = ctx.conversationProfile;
  const orderPlacement = profile?.orderPlacement;
  const priceQuote = profile?.priceQuote;

  // ==========================================================================
  // 默认款式 = 客户进入时绑定的 productId（来自商品链接）。
  // 也即：买家通过商品链接进店咨询，默认就是当前那款衣服，不需要再让客户口头确认一次。
  // 只有当客户中途明确换款（productIntent 来源是 message）或者根本没有 productId
  // 也没有 productIntent 时，才视为"未锁定款式"——那种情况下还得回到 ask_product。
  // 判定"款式已锁定"：满足以下任一
  //   1) 链接绑定了 productId（默认款，最常见）
  //   2) productIntent 来源是用户消息（中途换了款 / 主动指定了款）
  //   3) 客户已给过档期 / 身高 / 体重（隐含款式已定）
  //   4) 已下单（最强信号）
  // ==========================================================================
  const productConfirmed =
    !!ctx.productId ||
    profile?.productIntent?.source === 'message' ||
    profile?.rentalPeriod?.startDate !== undefined ||
    profile?.heightCm !== undefined ||
    profile?.weightKg !== undefined ||
    !!orderPlacement?.orderNo;

  // 1. 最高优先级：repair（"没听懂"/"？"/澄清）
  if (isRepairQuestion(q)) {
    const orderReadiness = profile?.orderReadiness;
    const hint = profile?.orchestration?.followUpQuestion
      || (orderReadiness?.nextStep ? `我想确认的是，${orderReadiness.nextStep}` : '');
    return { kind: 'repair', hint: hint || undefined };
  }

  // 2. 已下单 + 物流相关 → 物流回复
  if (orderPlacement?.orderNo && isDeliveryQuestion(q)) {
    const start = profile?.rentalPeriod?.startDate;
    const { needsHandoff, handoffReason } = evaluateDeliveryUrgency(start);
    return { kind: 'post_order_delivery', rentalStartDate: start, needsHandoff, handoffReason };
  }

  // 3. 打招呼
  if (isGreetingQuestion(q)) {
    return { kind: 'greet' };
  }

  // 4. 已下单 + 非物流/价格/流程 → 已下单跟进（避免被推回前置 stage）
  if (orderPlacement?.orderNo
      && !isPriceQuestion(q)
      && !isRentalHowToQuestion(q)) {
    return { kind: 'post_order_followup' };
  }

  // 5. 泛泛"想租衣服"且没商品 → 要求款式
  if (isGenericRentIntent(q) && !ctx.effectiveProductText) {
    return { kind: 'ask_product' };
  }

  // 5.5 "有哪些款式/都有什么款"——属于商品目录查询，必须在档期推进之前拦截。
  // 否则 follow_flow 会把它推去 ask_period，用户会困惑"我问款式你问我档期"。
  if (isCatalogListQuestion(q)) {
    const decision = await callClassifier(ctx);
    const faqText = (decision.faqAnswer || '').trim();
    const text = faqText
      || '这边在租的款式有好几款，您对颜色或样式有偏好吗？比如双排扣、单排扣、深色还是浅色，我按您的喜好给您挑。';
    return { kind: 'answer_faq', text, orchestrationFollowUp: undefined };
  }

  // 5.6 "照片发我/实拍图/款式图"——图片由 imageReferences 前端卡片自动展示，
  // 客服只要给一句简短确认；未确认款式时 followUp 引导继续选款，不要追问档期。
  if (isMediaRequestQuestion(q)) {
    const text = productConfirmed
      ? '好，图给您发过来了，您看看合不合适。'
      : '好，图给您发过来了，看看这款合不合心意。';
    const followUp = productConfirmed ? undefined : '合适的话我帮您记下这款，再给您对后面的档期。';
    return { kind: 'answer_faq', text, orchestrationFollowUp: followUp };
  }

  // 6. 怎么租
  if (isRentalHowToQuestion(q)) {
    return {
      kind: 'rental_howto',
      productId: ctx.productId,
      dailyPrice: priceQuote?.dailyPrice,
      renewalDailyPrice: priceQuote?.renewalDailyPrice,
      shippingPolicy: priceQuote?.shippingPolicy,
    };
  }

  // 7. "当前链接这款" + 有商品上下文
  if (isCurrentLinkProductQuestion(q) && (ctx.productId || ctx.effectiveProductText)) {
    return {
      kind: 'current_link_confirm',
      productText: ctx.effectiveProductText,
      productId: ctx.productId,
      dailyPrice: priceQuote?.dailyPrice,
      renewalDailyPrice: priceQuote?.renewalDailyPrice,
    };
  }

  // 8. 身高体重回忆
  if (isBodyMeasurementRecallQuestion(q)) {
    if (ctx.bodyProfilesCount === 0) return { kind: 'recall_body_empty' };
    if (ctx.bodyProfilesCount > 1) return { kind: 'recall_body_ambiguous', labels: ctx.bodyProfilesLabels };
    // 单档案 → 走 follow_flow 让 LLM 直接回
  }

  // 8.5 用户在问"尺码政策"——能不能选尺码、尺码怎么选、不合适怎么办之类。
  // 必须正面回答尺码规则（按身高体重配 + 免费换码），不能被 LLM 兜底误推到档期/选款。
  // 已经有身高体重 → 直接给推荐尺码；否则用 ask_body 模板（顺带把档期/数量缺哪问哪）
  if (isSizeQuestion(q)) {
    const hasBody = profile?.heightCm !== undefined && profile?.weightKg !== undefined;
    const sizePolicy = '尺码这边按您的身高体重给您配，到手不合身的话我们支持免费换码。';
    if (hasBody) {
      const picked = pickSizeByMeasurement(profile!.heightCm as number, profile!.weightKg as number);
      const sizeLine = picked.size === '尺码待人工确认'
        ? '您这个身高体重稍微偏一点，我让人工再帮您核对一下码。'
        : `按您 ${profile!.heightCm}cm / ${profile!.weightKg}kg，这款您穿 ${picked.size} 更合适。`;
      return {
        kind: 'answer_faq',
        text: `${sizePolicy}${sizeLine}`,
        orchestrationFollowUp: undefined,
      };
    }
    return {
      kind: 'answer_faq',
      text: sizePolicy,
      orchestrationFollowUp: '您把身高体重发我，我这边马上帮您看尺码。',
    };
  }

  // 9. 价格 + 还有流程要走 → 先报价 + 追加下一步提示
  if (isPriceQuestion(q)) {
    const nextProfile = deriveNextProfile(ctx);
    const follow = nextActionToAction(nextProfile);
    const nextPrompt = follow ? previewFollowPrompt(follow) : undefined;
    return {
      kind: 'quote_price',
      dailyPrice: priceQuote?.dailyPrice,
      renewalDailyPrice: priceQuote?.renewalDailyPrice,
      shippingPolicy: priceQuote?.shippingPolicy,
      nextPrompt,
    };
  }

  // 10. 用户本轮提供了新信息（身高体重/档期/款式/数量）→ 根据预测 profile 推下一步
  if (ctx.providedBody || ctx.providedPeriod || ctx.providedQuantity) {
    // 10.0 款式还没锁定前不能推进体型/档期流程——这只在没有 productId 也没有
    // 用户主动选款时才发生（极少数情况，进入入口未绑定商品的场景）
    if (!productConfirmed) {
      return { kind: 'ask_product' };
    }
    // 10a. 异常数据先礼貌确认，不强推
    if (ctx.providedBody) {
      const { heightCm, weightKg } = ctx.providedBody;
      const existingHeight = profile?.heightCm;
      const existingWeight = profile?.weightKg;
      // 用户给的体重 > 120kg，且没同时给身高，很可能单位写错（175kg 更像 175cm 或 175 斤）
      if (weightKg !== undefined && weightKg > 120 && heightCm === undefined && existingHeight === undefined) {
        return { kind: 'confirm_body_anomaly', weightKg, suspicion: 'weight_too_high' };
      }
      // 身高 > 220cm 或 < 100cm 几乎肯定笔误
      if (heightCm !== undefined && heightCm > 220) {
        return { kind: 'confirm_body_anomaly', heightCm, suspicion: 'height_too_high' };
      }
      if (heightCm !== undefined && heightCm < 100) {
        return { kind: 'confirm_body_anomaly', heightCm, suspicion: 'height_too_low' };
      }
      // 旁通: 如果已有数据 + 本轮只提供了一项，使用合并后的数据 —— 由 deriveNextProfile 处理
      void existingWeight;
    }
    const nextProfile = deriveNextProfile(ctx);
    const action = nextActionToAction(nextProfile);
    if (action) return action;
  }

  // 11. 纯确认（"对"/"好的"）+ 上一条客服在确认资料 → 推下一步
  if (isSimpleConfirmation(q)
      && (isPendingBodyMeasurementConfirmation(ctx.lastAssistantMessage)
          || isPendingRentalPeriodConfirmation(ctx.lastAssistantMessage))) {
    const nextProfile = deriveNextProfile(ctx);
    const action = nextActionToAction(nextProfile);
    if (action) return action;
  }

  // 12. 下单意图 + 已满足 → 直接 guide_order
  if (isOrderQuestion(q)) {
    const nextProfile = deriveNextProfile(ctx);
    const orderReadiness = nextProfile.orderReadiness;
    if (orderReadiness?.readyToOrder) {
      return {
        kind: 'guide_order',
        size: nextProfile.sizeRecommendation?.recommendedSize,
        startDate: nextProfile.rentalPeriod?.startDate,
        endDate: nextProfile.rentalPeriod?.endDate,
        dailyPrice: priceQuote?.dailyPrice ?? findProduct(ctx.productId)?.dailyPrice,
      };
    }
    const action = nextActionToAction(nextProfile);
    if (action) return action;
  }

  // 13. 兜底：LLM 分类器决定 follow_flow / faq / small_talk / handoff
  const decision = await callClassifier(ctx);

  if (decision.mode === 'handoff') {
    return { kind: 'handoff', reason: decision.handoffReason || '需人工处理', text: '这个问题我帮您转一下店长跟进，稍等一下。' };
  }
  if (decision.mode === 'small_talk') {
    const text = (decision.smallTalkText || '好嘞').trim().slice(0, 40);
    return { kind: 'small_talk', text };
  }
  if (decision.mode === 'answer_faq') {
    const text = (decision.faqAnswer || '').trim();
    // 未确认款式时，answer_faq 的 followUp 不能是档期/身高体重的追问，
    // 必须把用户拉回"选款"环节
    if (!productConfirmed) {
      return {
        kind: 'answer_faq',
        text: text || '这边需要再帮您确认一下，稍等。',
        orchestrationFollowUp: '您先把中意的款式或商品编号发我，我帮您对一下。',
      };
    }
    const nextProfile = deriveNextProfile(ctx);
    const follow = nextActionToAction(nextProfile);
    const followUp = follow ? previewFollowPrompt(follow) : undefined;
    return { kind: 'answer_faq', text: text || '这边需要再帮您确认一下，稍等。', orchestrationFollowUp: followUp };
  }
  // mode === 'follow_flow'
  // 未确认款式时，follow_flow 绝不能推到 ask_period/ask_body/confirm_size；
  // 必须先把客户拉回选款环节
  if (!productConfirmed) {
    return { kind: 'ask_product' };
  }
  const nextProfile = deriveNextProfile(ctx);
  const action = nextActionToAction(nextProfile);
  return action ?? { kind: 'ask_product' };
}

// orchestrator 的 nextAction → 我们 Action 枚举
function nextActionToAction(profile: ConversationProfile): Action | undefined {
  const orch = profile.orchestration;
  const readiness = profile.orderReadiness;
  if (!orch || !readiness) return undefined;

  const priceQuote = profile.priceQuote;
  const productText = profile.productIntent?.currentProductText;
  const size = profile.sizeRecommendation?.recommendedSize;
  const start = profile.rentalPeriod?.startDate;
  const end = profile.rentalPeriod?.endDate;
  const qty = profile.quantity?.count ?? 1;
  const quantityIsDefault = !(profile.quantity?.isExplicit);
  const missingBody = !!readiness.needHeightWeight;
  const missingPeriod = !!readiness.needRentalPeriod;
  const missingQuantity = !!readiness.needQuantity;

  if (readiness.readyToOrder) {
    return { kind: 'guide_order', size, startDate: start, endDate: end, dailyPrice: priceQuote?.dailyPrice, quantity: qty, quantityIsDefault };
  }

  switch (orch.nextAction) {
    case 'ask_product':
      return { kind: 'ask_product' };
    case 'ask_rental_period':
      return { kind: 'ask_period', productText, missingBody, missingQuantity };
    case 'ask_body_measurements':
      return {
        kind: 'ask_body',
        startDate: start,
        endDate: end,
        knownHeightCm: profile.heightCm,
        knownWeightKg: profile.weightKg,
        missingPeriod,
        missingQuantity,
      };
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
          };
    case 'check_availability':
      return { kind: 'check_availability' };
    case 'confirm_review':
      return { kind: 'confirm_review', productText, startDate: start, endDate: end, size, quantity: qty, quantityIsDefault };
    case 'guide_order':
      return { kind: 'guide_order', size, startDate: start, endDate: end, dailyPrice: priceQuote?.dailyPrice, quantity: qty, quantityIsDefault };
    default:
      return undefined;
  }
}

// 给 answer_faq / quote_price 做"回答完顺便推半句"的预览文案
function previewFollowPrompt(action: Action): string | undefined {
  switch (action.kind) {
    case 'ask_product':
      return '您先把具体款式或者商品编号发我。';
    case 'ask_period':
      return '您把哪天使用、哪天归还发我。';
    case 'ask_body':
      return '您再把身高和体重发我，这边帮您看尺码。';
    case 'confirm_size':
      return `尺码这边按 ${action.size} 码给您配。`;
    case 'confirm_review':
      return '信息都对的话我这边继续给您往下安排。';
    case 'guide_order':
      return '您这边直接下单就行。';
    default:
      return undefined;
  }
}
