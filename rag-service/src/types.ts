export type SourceType = 'rule' | 'history' | 'product';

// ============ 用户意图分类器 ============
// 代替散落在 memory-store / action-picker 里的"这句话是不是图片请求/是不是确认/..."
// 这种零碎关键词判断，统一一个 enum + 一次 LLM 调用产出。
export type UserIntent =
  | 'select_product'     // 想租黑色西装 / 换成 SUIT-001 / 要那件双排扣
  | 'provide_period'     // 5月10到12号 / 租3天
  | 'provide_body'       // 174cm 75kg / 我身高175
  | 'confirm'            // 好的 / 对的 / 没错 / 就这样
  | 'ask_info'           // 发我图 / 尺码表 / 价格多少 / 怎么租
  | 'place_order'        // 怎么下单 / 我下单
  | 'small_talk'         // 在吗 / 你好 / 谢谢 / emoji
  | 'request_handoff'    // 投诉 / 转人工 / 要店长
  | 'update_correction'  // 改成 5月15 / 不是L是M / 错了
  | 'other';             // 兜底

export interface IntentClassification {
  intent: UserIntent;
  confidence: 'high' | 'medium' | 'low';
  source: 'keyword' | 'llm' | 'fallback';
  reason?: string;
}

export type ContentType = 'qa' | 'text' | 'image';

export interface KnowledgeChunk {
  id: string;
  text: string;
  sourceType: SourceType;
  contentType: ContentType;
  filePath: string;
  title: string;
  chunkIndex: number;
  imageUrl?: string;
  caption?: string;
}

export interface ChatRequestBody {
  customerId: string;
  productId?: string;
  conversationId?: string;
  question: string;
  imageUrl?: string;
  sessionContext?: Record<string, string | number | boolean | null>;
  stylistPrompt?: string;
}

export interface BodyProfile {
  profileId: string;
  label: string;
  heightCm?: number;
  weightKg?: number;
  source: 'message' | 'sessionContext' | 'manual';
  lastMentionedAt: string;
  notes?: string;
}

export interface RentalPeriod {
  startDate?: string;
  endDate?: string;
  source: 'message' | 'sessionContext' | 'manual';
  lastMentionedAt: string;
}

export interface ProductIntent {
  currentProductText?: string;
  source: 'message' | 'sessionContext' | 'manual';
  lastMentionedAt: string;
}

export interface PriceQuote {
  dailyPrice?: number;
  renewalDailyPrice?: number;
  currency?: string;
  shippingPolicy?: string;
  pricingNote?: string;
  source: 'knowledge' | 'sessionContext' | 'manual';
  lastQuotedAt: string;
}

export interface SizeRecommendation {
  recommendedSize?: string;
  confidence?: 'low' | 'medium' | 'high';
  missingFields?: string[];
  source: 'knowledge' | 'manual' | 'rule';
  lastRecommendedAt: string;
}

export interface AvailabilityCheck {
  hasSize?: boolean;
  hasInventory?: boolean;
  hasSchedule?: boolean;
  availableSize?: string;
  productId?: string;
  rentalStartDate?: string;
  rentalEndDate?: string;
  source: 'knowledge' | 'manual' | 'api';
  checkedAt: string;
}

export interface ReviewCheck {
  needed: boolean;
  completed: boolean;
  passed: boolean;
  reviewedAt?: string;
  source: 'system' | 'manual';
  summary?: string;
  failureReason?: string;
}

export interface AvailabilityQueryInput {
  productId: string;
  heightCm: number;
  weightKg: number;
  rentalStartDate: string;
  rentalEndDate: string;
}

export interface Review {
  score: number; // 1-10，评估失败为 0
  issues: string[];
  suggestions: string[];
  suggestedReply?: string; // LLM 给出的"理想回复"建议
  timestamp: string;
  source: 'system' | 'user';
  evaluatedReply?: string;
  promptVersion?: string; // 发生评估时的 prompt 版本哈希
  chatModel?: string; // 生成该客服回复时使用的对话模型
  evaluatorModel?: string; // 执行评估的模型
  error?: string; // 评估失败时的错误摘要
}

export interface AvailabilityQueryResult {
  available: boolean;
  availableSize?: string;
  checkedAt: string;
  source: 'api';
}

export interface OrderReadiness {
  needProductId: boolean;
  needRentalPeriod: boolean;
  needHeightWeight: boolean;
  needSizeRecommendation: boolean;
  needAvailabilityCheck: boolean;
  needReviewCheck?: boolean;
  // 数量默认 1，所以不会作为下单 blocker；这里记录"用户是否显式指定过"
  // 仅用于 follow-up 文案，不参与 readyToOrder 判定
  needQuantity?: boolean;
  readyToOrder: boolean;
  nextStep?: string;
  updatedAt: string;
}

export interface QuantityInfo {
  count: number;          // 件数，未显式给出时按默认 1 处理
  isExplicit: boolean;    // 是否客户主动给出过（false 表示走默认值）
  source: 'message' | 'sessionContext' | 'manual' | 'default';
  lastMentionedAt: string;
}

export interface OrderPlacement {
  orderNo: string;
  placedAt: string;
  source: 'manual';
}

export interface HandoffStatus {
  needed: boolean;
  reason?: string;
  createdAt: string;
  source: 'system' | 'manual';
}

export type ConversationStage =
  | 'intent_discovery'
  | 'product_locking'
  | 'schedule_collecting'
  | 'body_collecting'
  | 'size_confirming'
  | 'availability_checking'
  | 'review_confirming'
  | 'order_guiding'
  | 'post_order_followup';

export type NextActionType =
  | 'ask_product'
  | 'ask_rental_period'
  | 'ask_body_measurements'
  | 'confirm_size'
  | 'check_availability'
  | 'confirm_review'
  | 'guide_order'
  | 'answer_question'
  | 'close_loop';

export interface ConversationOrchestration {
  stage: ConversationStage;
  currentGoal: string;
  pendingSlots: string[];
  completedSlots: string[];
  blockingIssues: string[];
  nextAction: NextActionType;
  followUpQuestion?: string;
  proactiveFollowUpCount?: number;
  proactiveFollowUpLimit?: number;
  lastProactiveFollowUpAt?: string;
  waitingForUser?: boolean;
  paused?: boolean;
  replyTemplateKey?: string;
  shouldUseRag: boolean;
  shouldUseBusinessTools: boolean;
  handoffNeeded: boolean;
  handoffReason?: string;
  updatedAt: string;
}

export interface ConversationProfile {
  heightCm?: number;
  weightKg?: number;
  rentalPeriod?: RentalPeriod;
  productIntent?: ProductIntent;
  quantity?: QuantityInfo;
  priceQuote?: PriceQuote;
  sizeRecommendation?: SizeRecommendation;
  availabilityCheck?: AvailabilityCheck;
  reviewCheck?: ReviewCheck;
  orderReadiness?: OrderReadiness;
  orderPlacement?: OrderPlacement;
  handoffStatus?: HandoffStatus;
  orchestration?: ConversationOrchestration;
  updatedAt: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: KnowledgeChunk;
}

export interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  intent?: UserIntent; // 仅用户消息有，记录这一轮分类器的 tag，方便 dashboard 回放/审计
}

export interface ProductMemory {
  productId: string;
  conversationId: string;
  summary: string;
  recentMessages: MemoryMessage[];
  conversationProfile: ConversationProfile;
  reviews: Review[];
  updatedAt: string;
}

export interface CustomerMemory {
  customerId: string;
  globalSummary: string;
  sessionContext: Record<string, string | number | boolean | null>;
  bodyProfiles: BodyProfile[];
  productMemories: Record<string, ProductMemory>;
  overallRating?: number;
  totalReviews: number;
  updatedAt: string;
}
