// 对话引擎：createDialogueEngine(ports, config) → { answer(input) }。
// 一次 turn 的管道编排（对应 legacy 的 rag.ts answerQuestion + server.ts /chat 胶水
// + memory-store.ts appendConversationMemory 三层合一）：
//   ① 记忆快照（MemoryPort.snapshot）
//   ② 意图分类（关键词 fast-path 在 domain，ClassifyPort 只做模糊兜底，§8.2 合并分类器）
//   ③ 知识检索（KnowledgeSearchPort；失败有声降级为空命中，不断链路）
//   ④ 门控事实抽取（extraction.extractTurnFacts：意图门控 + 确定性信号正交放行 + 融合）
//   ⑤ productText 门控（同上，含 sessionContext.defaultProductText 兜底）
//   ⑥ 构造 RuleContext → selectAction（有序规则表先行，LLM mode 兜底）
//   ⑦ generateReplyText（action-spec 约束 + 三层安全门 + 模板回退）→ sanitize
//   ⑧ handoff 映射（action.kind==='handoff' 或 post_order_delivery.needsHandoff）
//   ⑨ 计算 nextProfile 并单次 MemoryPort.commit（RAG 证据不写记忆；
//      消息滑窗 + profile 深合并 + summary 确定性重建都在 domain 完成）
// 舍弃项（随 RW-1）：图片通道（vision caption / 三层图片过滤 / 附图门控）、
// 异步 LLM 评估落 reviews（评测飞轮归 evals/）、sessionContext 持久化（db 无此列）。

import { findProduct, type CatalogFile } from './catalog.js'
import { extractTurnFacts } from './extraction.js'
import { generateReplyText, type GenerationFallbackReason } from './generation.js'
import {
  createAlwaysAvailablePort,
  type ConversationKey,
  type DialogueEnginePorts,
  type KnowledgeHit,
  type MemoryCommit,
} from './ports.js'
import {
  applyPostOrderOrchestrationOverride,
  applyReviewAndHandoffSignals,
  buildGlobalSummary,
  buildIncomingProfilePatch,
  buildProductSummary,
  buildConversationProfileSummary,
  extractBodyProfilesFromInput,
  inferAvailabilityCheck,
  inferOrderReadiness,
  inferPriceQuote,
  inferSizeRecommendation,
  mergeBodyProfiles,
  mergeConversationProfile,
  updateProactiveFollowUpState,
  type SessionContext,
} from './profile.js'
import { deriveConversationOrchestration } from './orchestrator.js'
import { createTurnClassifier } from './routing/classifier.js'
import { selectAction, type RuleContext } from './routing/rules.js'
import { sanitizeAnswerText } from './sanitize.js'
import type {
  ActionKind,
  ConversationProfile,
  IntentClassification,
  MemoryMessage,
  Stage,
} from './types.js'

/** 消息滑窗容量（legacy memory-store 的 MAX_RECENT_MESSAGES） */
const MAX_RECENT_MESSAGES = 6

/** engine.answer() 的输入契约（金标 runner 与 loop 共用） */
export interface EngineInput {
  customerId: string
  productId?: string
  conversationId?: string
  question: string
  sessionContext?: SessionContext
}

/** engine.answer() 的输出契约（金标 runner 与 loop 共用） */
export interface EngineResult {
  answer: string
  /** 命中的 Action kind（23 种之一） */
  action: ActionKind
  /** 提交后画像的会话阶段 */
  stage: Stage
  /** 'llm' = 受限生成产出；'fallback' = 模板回退（观测回退率） */
  answerSource: 'llm' | 'fallback'
  handoff?: { needed: true; reason: string }
  /** 统一的意图分类结果（含 source: keyword/llm/fallback） */
  intent: IntentClassification
  /** 本轮 commit 后的完整会话画像 */
  profile: ConversationProfile
  /** 文本知识命中（不写入记忆，仅透出观测/引用展示） */
  references: KnowledgeHit[]
}

export interface DialogueEngine {
  answer(input: EngineInput): Promise<EngineResult>
}

export interface EngineConfig {
  /** 已解析的商品目录（尺码规则/定价） */
  catalog: CatalogFile
  /** 版本化 prompt 配置的说话风格段（生成层 system prompt 用） */
  stylistPrompt: string
  /** 知识检索 topK（缺省交给端口默认值） */
  topK?: number
  /** 时钟注入（测试可控；缺省取系统时间） */
  now?: () => Date
  /** 有声降级观测钩子（知识检索失败 / 生成回退等），缺省静默 */
  onWarning?: (message: string) => void
}

/** conversationId 缺省时按 legacy 规则合成：customerId:productId / customerId:general */
export function buildConversationId(
  customerId: string,
  productId?: string,
  conversationId?: string,
): string {
  if (conversationId) return conversationId
  return productId ? `${customerId}:${productId}` : `${customerId}:general`
}

/** 画像判空：db 层未知画像可能给 {}，统一归一为 undefined（防御性收窄） */
function asExistingProfile(profile?: ConversationProfile): ConversationProfile | undefined {
  if (!profile) return undefined
  return Object.keys(profile).length > 0 ? profile : undefined
}

/** 创建对话引擎：纯 TS + 注入端口，任何模块可用 stub 离线测试 */
export function createDialogueEngine(
  ports: DialogueEnginePorts,
  config: EngineConfig,
): DialogueEngine {
  const availability = ports.availability ?? createAlwaysAvailablePort()
  const warn = config.onWarning ?? (() => {})

  return {
    async answer(input: EngineInput): Promise<EngineResult> {
      const now = (config.now?.() ?? new Date()).toISOString()
      const question = (input.question ?? '').trim()
      const key: ConversationKey = {
        customerId: input.customerId,
        productId: input.productId,
        conversationId: buildConversationId(
          input.customerId,
          input.productId,
          input.conversationId,
        ),
      }

      // ① 记忆快照
      const snapshot = await ports.memory.snapshot(key)
      const existingProfile = asExistingProfile(snapshot.conversationProfile)
      const recentMessages = snapshot.recentMessages
      const lastAssistantMessage = recentMessages
        .slice()
        .reverse()
        .find((message) => message.role === 'assistant')?.content

      // ② 意图分类（合并分类器：关键词 fast-path 零调用；LLM 至多一次、intent/mode 共享）
      const classifier = createTurnClassifier(ports.classify, {
        question,
        profile: existingProfile,
        recentMessages,
        lastAssistantMessage,
      })
      const intentClassification = await classifier.classifyIntent()

      // ③ 知识检索（失败降级为空命中——有声，不让整条问答链路崩溃）
      let references: KnowledgeHit[] = []
      try {
        references = await ports.knowledge.search(question, config.topK)
      } catch (error) {
        warn(
          `[engine] 知识检索失败，本轮跳过：${error instanceof Error ? error.message : String(error)}`,
        )
      }

      // ④⑤ 门控事实抽取 + productText 门控（含 defaultProductText 兜底）
      const defaultProductText =
        typeof input.sessionContext?.defaultProductText === 'string'
          ? input.sessionContext.defaultProductText
          : undefined
      const facts = await extractTurnFacts(ports.extract, {
        question,
        intent: intentClassification.intent,
        existingProfile,
        defaultProductText,
        now,
      })

      // ⑥ 构造 RuleContext → selectAction（fast-path 规则先行，mode 兜底惰性触发）
      const ruleCtx: RuleContext = {
        question,
        productId: input.productId,
        conversationProfile: existingProfile,
        bodyProfilesLabels: snapshot.bodyProfiles.map((p) => p.label).filter(Boolean),
        bodyProfilesCount: snapshot.bodyProfiles.length,
        lastAssistantMessage,
        effectiveProductText: facts.effectiveProductText,
        references,
        recentMessages,
        providedBody: facts.providedBody,
        providedPeriod: facts.providedPeriod,
        providedQuantity: facts.providedQuantity,
        catalog: config.catalog,
        now,
        decideMode: () =>
          classifier.decideMode({ references, productText: facts.effectiveProductText }),
      }
      const { action } = await selectAction(ruleCtx)

      // ⑦ 受限生成（三层安全门 + 模板回退）→ sanitize
      const { text: rawAnswer, source: answerSource } = await generateReplyText(
        ports.generate,
        action,
        {
          question,
          productId: input.productId,
          conversationProfile: existingProfile,
          effectiveProductText: facts.effectiveProductText,
          recentMessages,
          stylistPrompt: config.stylistPrompt,
        },
        (reason: GenerationFallbackReason, detail?: string) => {
          // SKIP_GENERATION_KINDS 直走模板是设计内路径，不算告警
          if (reason !== 'skip-generation-kind') {
            warn(`[engine] 生成回退（${reason}）${detail ? `：${detail}` : ''}`)
          }
        },
      )
      const answer = sanitizeAnswerText(rawAnswer)

      // ⑧ handoff 映射
      const handoff =
        action.kind === 'handoff'
          ? { needed: true as const, reason: action.reason }
          : action.kind === 'post_order_delivery' && action.needsHandoff
            ? { needed: true as const, reason: action.handoffReason || '下单后物流时间需人工确认' }
            : undefined

      // ⑨ 计算 nextProfile 并单次 commit
      const { nextProfile, commit } = await computeTurnMemory({
        snapshot,
        existingProfile,
        question,
        answer,
        input,
        facts,
        intentClassification,
        handoff,
        catalog: config.catalog,
        availability,
        now,
      })
      await ports.memory.commit(key, commit)

      return {
        answer,
        action: action.kind,
        stage: nextProfile.orchestration?.stage ?? 'intent_discovery',
        answerSource,
        handoff,
        intent: intentClassification,
        profile: nextProfile,
        references,
      }
    },
  }
}

/**
 * ⑨ 记忆推进：镜像 legacy server.ts 的 sessionContext 增补（defaultProductText /
 * handoffNeeded 注入）+ memory-store.ts appendConversationMemoryInternal 的完整顺序：
 * 体型档案合并 → 全局摘要 → 画像补丁合并 → 复核/接管信号 → infer* 推进 →
 * orchestration → 已下单覆写 → 主动追问节流 → 消息滑窗 + 会话摘要。
 * 产出单次 commit 的完整 patch（RAG 证据与 reviews 不在其中）。
 */
async function computeTurnMemory(args: {
  snapshot: {
    recentMessages: MemoryMessage[]
    bodyProfiles: import('./types.js').BodyProfile[]
    summary: string
    globalSummary: string
  }
  existingProfile?: ConversationProfile
  question: string
  answer: string
  input: EngineInput
  facts: Awaited<ReturnType<typeof extractTurnFacts>>
  intentClassification: IntentClassification
  handoff?: { needed: true; reason: string }
  catalog: CatalogFile
  availability: NonNullable<DialogueEnginePorts['availability']>
  now: string
}): Promise<{ nextProfile: ConversationProfile; commit: MemoryCommit }> {
  const { snapshot, existingProfile, question, answer, input, facts, now, catalog } = args

  // 镜像 legacy server.ts /chat 的 sessionContext 增补：productIntentText 归一、
  // defaultProductText 用商品目录名兜底（legacy 硬编码 SUIT-001 映射，重写查目录，行为等价）、
  // handoff 信号回灌记忆
  const rawContext = input.sessionContext ?? {}
  const sessionContext: SessionContext = {
    ...rawContext,
    productIntentText:
      (typeof rawContext.productIntentText === 'string' ? rawContext.productIntentText : null) ??
      (typeof rawContext.productText === 'string' ? rawContext.productText : null) ??
      null,
    defaultProductText:
      (typeof rawContext.defaultProductText === 'string' ? rawContext.defaultProductText : null) ??
      findProduct(catalog, input.productId)?.name ??
      null,
    handoffNeeded: args.handoff?.needed ?? null,
    handoffReason: args.handoff?.reason ?? null,
  }

  // 客户维度：体型档案合并 + 全局摘要重建
  const extractedBodyProfiles = extractBodyProfilesFromInput({ question, sessionContext, now })
  const bodyProfiles = mergeBodyProfiles(snapshot.bodyProfiles ?? [], extractedBodyProfiles)
  const globalSummary = buildGlobalSummary(
    snapshot.globalSummary,
    sessionContext,
    question,
    bodyProfiles,
  )

  // 会话维度：画像补丁（融合事实入记忆）→ 深合并 → 复核/接管信号
  let profile = mergeConversationProfile(
    existingProfile,
    buildIncomingProfilePatch({
      question,
      sessionContext,
      now,
      existingProfile,
      extractedFacts: facts.fusedFacts,
    }),
    now,
  )
  profile = applyReviewAndHandoffSignals(profile, { question, sessionContext, now })

  // infer* 推进：报价 / 尺码 / 库存核验（走 AvailabilityPort）/ 下单就绪度 / 编排
  const priceQuote = inferPriceQuote(catalog, input.productId, now) ?? profile.priceQuote
  const sizeRecommendation = inferSizeRecommendation(catalog, profile, now)
  const availabilityCheck = await inferAvailabilityCheck(
    args.availability,
    profile,
    now,
    sizeRecommendation,
    input.productId,
  )
  const orderReadiness = inferOrderReadiness(
    profile,
    input.productId,
    now,
    sizeRecommendation,
    availabilityCheck,
  )
  const orchestration = deriveConversationOrchestration({
    profile: {
      ...profile,
      priceQuote,
      sizeRecommendation,
      availabilityCheck,
      orderReadiness,
      updatedAt: now,
    },
    orderReadiness,
    productId: input.productId,
    now,
  })
  profile = {
    ...profile,
    priceQuote,
    sizeRecommendation,
    availabilityCheck,
    orderReadiness,
    orchestration,
    updatedAt: now,
  }
  profile = applyPostOrderOrchestrationOverride(profile, now)
  profile = updateProactiveFollowUpState({
    existingProfile,
    nextProfile: profile,
    question,
    answer,
    now,
  })

  // 消息滑窗 + 会话摘要（滑窗容量与 legacy 一致：6 条）
  const userMessage: MemoryMessage = {
    role: 'user',
    content: question,
    timestamp: now,
    ...(args.intentClassification.intent ? { intent: args.intentClassification.intent } : {}),
  }
  const assistantMessage: MemoryMessage = { role: 'assistant', content: answer, timestamp: now }
  const nextRecentMessages = [...snapshot.recentMessages, userMessage, assistantMessage].slice(
    -MAX_RECENT_MESSAGES,
  )
  const conversationProfileSummary = buildConversationProfileSummary(profile)
  const summary = [
    conversationProfileSummary ? `当前会话资料: ${conversationProfileSummary}` : '',
    buildProductSummary(snapshot.summary, nextRecentMessages),
  ]
    .filter(Boolean)
    .slice(-3)
    .join('\n')

  return {
    nextProfile: profile,
    commit: {
      appendMessages: [userMessage, assistantMessage],
      conversationProfile: profile,
      bodyProfiles,
      summary,
      globalSummary,
    },
  }
}
