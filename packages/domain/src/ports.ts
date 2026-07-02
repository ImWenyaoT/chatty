// @rental/domain 对外部世界的全部依赖（docs/architecture.md §4 + AvailabilityPort 补充）。
// 模式功课「端口与适配器」：domain 只定义接口，@rental/llm / @rental/db 提供实现，
// apps/web（组合根）负责装配。全部端口都可以用内存 stub 离线替换（测试即证明）。
//
// 与 legacy 的对应关系：
//   ClassifyPort   ← intent-classifier.ts 的 classify_intent + action-picker.ts 的 decide_reply
//                    （§8.2 合并分类器：一次调用同时返回 intent 10 类 + mode 4 类）
//   ExtractPort    ← memory-store.ts 的 extractConversationFactsWithModel（LLM 事实抽取）
//   GeneratePort   ← generate-text.ts 的 openai.chat.completions.create 调用
//   KnowledgeSearchPort ← rag.ts 的 searchKnowledge（embedding + 向量检索都在适配器内）
//   MemoryPort     ← memory-store.ts 的 getCustomerMemory/getProductMemory（snapshot）
//                    + appendConversationMemory 的持久化半边（commit）
//   AvailabilityPort ← availability-service.ts 的 queryAvailability（库存/档期查询接缝）

import type {
  AvailabilityQueryInput,
  AvailabilityQueryResult,
  BodyProfile,
  ConversationProfile,
  MemoryMessage,
  ReplyMode,
  Stage,
} from './types.js'

// ============ 分类端口（intent + mode 合并，见 §8.2） ============

/** 分类端口输入：一句话 + 领域侧整理好的上下文（适配器负责拼 prompt） */
export interface ClassifyPortInput {
  question: string
  /** 当前会话阶段（来自既有 profile.orchestration.stage） */
  stage?: Stage
  /** 会话画像（适配器可摘取已锁商品/档期/体型等做上下文行） */
  profile?: ConversationProfile
  recentMessages?: MemoryMessage[]
  lastAssistantMessage?: string
  /** 当前生效的商品意向文本（mode 决策上下文；调用时机不同可能为空） */
  productText?: string
  /** 本轮检索到的知识命中（faqAnswer 需要从中摘答案） */
  references?: KnowledgeHit[]
}

/**
 * 分类端口原始返回：字段全部宽松可缺——枚举白名单校验、非法值保守回退
 * 都由调用方 routing/classifier.ts 完成（tool_choice 强制属于适配器职责）。
 */
export interface ClassifyPortResult {
  /** 10 类意图之一；非法/缺失时调用方回退关键词分类 */
  intent?: string
  /** 4 类回复模式之一；非法/缺失时调用方回退 follow_flow */
  mode?: string
  /** mode=answer_faq 时的 1-3 句直接回答 */
  faqAnswer?: string
  /** mode=small_talk 时的简短回应 */
  smallTalkText?: string
  /** mode=handoff 时的触发原因 */
  handoffReason?: string
  /** 意图判定理由（debug 用） */
  reason?: string
}

export interface ClassifyPort {
  /** 一次调用同时返回意图（门控事实写入）与回复模式（路由兜底） */
  classify(input: ClassifyPortInput): Promise<ClassifyPortResult>
}

// ============ LLM 事实抽取端口 ============

/**
 * 抽取端口原始返回。LLM 返回形态不可控（字符串 / {start,end} / {startDate,endDate}
 * 都见过），归一化兼容逻辑在 domain 的 extraction.ts，端口只透传解析后的 JSON 字段。
 */
export interface RawExtractedFacts {
  rentalPeriod?: unknown
  productIntent?: unknown
}

export interface ExtractPort {
  /** LLM 事实抽取（rentalPeriod / productIntent），regex 先行后的兜底 */
  extract(input: { question: string; existing?: ConversationProfile }): Promise<RawExtractedFacts>
}

// ============ 受限文本生成端口 ============

export interface GeneratePort {
  /** 受限文本生成；调用方（generation.ts）负责安全门与模板回退 */
  generate(input: { system: string; user: string; maxTokens: number }): Promise<string>
}

// ============ 知识检索端口 ============

/** 文本知识命中（图片通道随 RW-1 舍弃，KnowledgeChunk 的 contentType/imageUrl 不再进 domain） */
export interface KnowledgeHit {
  score: number
  title: string
  text: string
  id?: string
  sourceType?: string
  filePath?: string
  chunkIndex?: number
}

export interface KnowledgeSearchPort {
  search(question: string, topK?: number): Promise<KnowledgeHit[]>
}

// ============ 记忆端口 ============

/** 会话定位键。conversationId 缺省时由 engine 按 legacy 规则合成（customerId:productId / :general） */
export interface ConversationKey {
  customerId: string
  productId?: string
  conversationId: string
}

/**
 * 记忆快照：形状对齐 @rental/db 的 MemorySnapshotRecord（domain 不 import db，
 * 这里是同构自定义）。无既有画像时 conversationProfile 为 undefined（db 侧的 {}
 * 由适配器归一成 undefined，或由 engine 防御性判空）。
 */
export interface MemorySnapshot {
  recentMessages: MemoryMessage[]
  conversationProfile?: ConversationProfile
  bodyProfiles: BodyProfile[]
  summary: string
  globalSummary: string
}

/**
 * 一轮对话的记忆提交增量：语义 = 整块替换（appendMessages 除外，走滑窗追加），
 * 深合并（existing ⊕ incoming）已在 domain 完成后才落到这里。
 * 形状对齐 @rental/db 的 MemoryCommitPatch。
 */
export interface MemoryCommit {
  /** 本轮新增消息（user/assistant），由适配器追加进 recentMessages 滑窗 */
  appendMessages?: MemoryMessage[]
  /** 合并后的完整会话画像（整块替换） */
  conversationProfile?: ConversationProfile
  /** 合并后的完整体型档案列表（整块替换） */
  bodyProfiles?: BodyProfile[]
  /** 当前会话摘要（确定性字符串重建） */
  summary?: string
  /** 客户全局摘要 */
  globalSummary?: string
}

export interface MemoryPort {
  snapshot(key: ConversationKey): Promise<MemorySnapshot>
  /** 每轮 engine.answer() 结束时恰好调用一次 */
  commit(key: ConversationKey, patch: MemoryCommit): Promise<void>
}

// ============ 库存/档期查询端口 ============

export interface AvailabilityPort {
  queryAvailability(input: AvailabilityQueryInput): Promise<AvailabilityQueryResult>
}

/**
 * 缺省实现：行为 = legacy availability-service.ts 的占位——恒返回可租、可用尺码 L。
 * 接真实库存系统时替换此端口，调用方（profile 推进 / engine）不感知。
 */
export function createAlwaysAvailablePort(): AvailabilityPort {
  return {
    async queryAvailability() {
      return {
        available: true,
        availableSize: 'L',
        checkedAt: new Date().toISOString(),
        source: 'api',
      }
    },
  }
}

// ============ 端口集合（engine 装配用） ============

/** createDialogueEngine 的端口装配包；availability 缺省用 createAlwaysAvailablePort() */
export interface DialogueEnginePorts {
  classify: ClassifyPort
  extract: ExtractPort
  generate: GeneratePort
  knowledge: KnowledgeSearchPort
  memory: MemoryPort
  availability?: AvailabilityPort
}

// re-export 给端口使用方（保持 ports.ts 是端口层的单一入口）
export type { ReplyMode }
