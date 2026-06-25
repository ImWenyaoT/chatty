export interface Review {
  score: number;
  issues: string[];
  suggestions: string[];
  suggestedReply?: string;
  timestamp: string;
  source: 'system' | 'user';
  evaluatedReply?: string;
  promptVersion?: string;
  chatModel?: string;
  evaluatorModel?: string;
  error?: string;
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
  | 'other';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  intent?: UserIntent;
}

export interface ProductMemory {
  productId: string;
  conversationId: string;
  summary: string;
  recentMessages: Message[];
  conversationProfile: any;
  reviews: Review[];
}

export interface CustomerListItem {
  customerId: string;
  globalSummary: string;
  overallRating?: number;
  totalReviews: number;
  updatedAt: string;
  productMemories: ProductMemory[];
}

export interface CustomerListResponse {
  customers: CustomerListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ConfigInfo {
  promptVersion: string;
  promptVersionName: string;
  chatModel: string;
  evaluatorModel: string;
  embeddingModel: string;
  products: { id: string; name: string }[];
}

export interface VersionSummary {
  version: string;
  count: number;
  avgScore: number;
  lowScoreCount: number;
  errorCount: number;
}

export interface ReviewSummary {
  promptVersions: VersionSummary[];
  topIssues: { issue: string; count: number }[];
  topSuggestions: { suggestion: string; count: number }[];
  totalConversations: number;
  totalReviews: number;
}

export type KnowledgeSourceType = 'rule' | 'history' | 'product';
export type KnowledgeContentType = 'qa' | 'text' | 'image';

export interface KnowledgeEntry {
  pointId: string;
  chunkId: string;
  text: string;
  sourceType: KnowledgeSourceType;
  contentType: KnowledgeContentType;
  filePath: string;
  title: string;
  chunkIndex: number;
  imageUrl?: string;
  caption?: string;
}

export interface KnowledgeListResponse {
  entries: KnowledgeEntry[];
  total: number;
  page: number;
  limit: number;
  stats: {
    total: number;
    totalEntries: number;
    bySourceType: Record<KnowledgeSourceType, number>;
    entriesBySourceType: Record<KnowledgeSourceType, number>;
    byContentType: Record<KnowledgeContentType, number>;
    byTitle: { title: string; count: number }[];
  };
}

export type KnowledgeFormat = 'text' | 'markdown' | 'qa' | 'csv' | 'json' | 'image' | 'product';

export interface KnowledgeAddPayload {
  format: KnowledgeFormat;
  title?: string;
  sourceType?: KnowledgeSourceType;
  text?: string;
  content?: string;
  csv?: string;
  items?: { question: string; answer: string }[];
  imageUrl?: string;
  caption?: string;
  tags?: string[];
  relatedQuestions?: string[];
  productId?: string;
  name?: string;
  description?: string;
  attributes?: { label: string; value: string }[];
  faqs?: { question: string; answer: string }[];
  images?: { imageUrl: string; caption: string; tags?: string[] }[];
}
