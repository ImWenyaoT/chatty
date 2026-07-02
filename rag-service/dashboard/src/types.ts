export interface Review {
  score: number
  issues: string[]
  suggestions: string[]
  suggestedReply?: string
  timestamp: string
  source: 'system' | 'user'
  evaluatedReply?: string
  promptVersion?: string
  chatModel?: string
  evaluatorModel?: string
  error?: string
}

export type UserIntent =
  | 'select_product'
  | 'provide_period'
  | 'provide_body'
  | 'confirm'
  | 'ask_info'
  | 'place_order'
  | 'small_talk'
  | 'request_handoff'
  | 'update_correction'
  | 'other'

export interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  intent?: UserIntent
}

// 会话档案在 dashboard 只做只读展示，这里只声明用到的字段，
// 完整结构见 rag-service/src/types.ts 的 ConversationProfile。
export interface ConversationProfileView {
  heightCm?: number
  weightKg?: number
  rentalPeriod?: { startDate?: string | null; endDate?: string | null }
  productIntent?: { currentProductText?: string }
  orchestration?: { stage?: string }
  orderPlacement?: { orderNo?: string }
}

export interface ProductMemory {
  productId: string
  conversationId: string
  summary: string
  recentMessages: Message[]
  conversationProfile?: ConversationProfileView
  reviews: Review[]
}

export interface CustomerListItem {
  customerId: string
  globalSummary: string
  overallRating?: number
  totalReviews: number
  updatedAt: string
  productMemories: ProductMemory[]
}

export interface CustomerListResponse {
  customers: CustomerListItem[]
  total: number
  page: number
  limit: number
}

export interface ConfigInfo {
  promptVersion: string
  promptVersionName: string
  chatModel: string
  evaluatorModel: string
  embeddingModel: string
  products: { id: string; name: string }[]
}

export interface VersionSummary {
  version: string
  count: number
  avgScore: number
  lowScoreCount: number
  errorCount: number
}

export interface ReviewSummary {
  promptVersions: VersionSummary[]
  topIssues: { issue: string; count: number }[]
  topSuggestions: { suggestion: string; count: number }[]
  totalConversations: number
  totalReviews: number
}
