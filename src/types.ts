export const userSegments = [
  "new_user",
  "active",
  "high_value",
  "price_sensitive",
  "churn_risk",
] as const;

export type UserSegment = (typeof userSegments)[number];

export interface Product {
  product_id: string;
  name: string;
  category: string;
  price_cents: number;
  description: string;
  brand: string;
  seller_id: string;
  stock: number;
  tags: string[];
  popularity_score: number;
  image_url: string;
  source: string;
}

export interface UserContext {
  recent_views?: string[];
  recent_purchases?: string[];
  preferred_categories?: string[];
  min_price_cents?: number;
  max_price_cents?: number;
}

export interface UserProfile {
  user_id: string;
  segment: UserSegment;
  preferred_categories: string[];
  min_price_cents: number;
  max_price_cents: number;
  recent_views: string[];
  recent_purchases: string[];
}

export interface KnowledgeDocument {
  doc_id: string;
  title: string;
  content: string;
  category: string;
  product_id: string | null;
  source: string;
}

export interface KnowledgeHit extends KnowledgeDocument {
  chunk_ordinal: number;
  relevance_score: number;
}

export interface MarketingStrategy {
  segment: UserSegment;
  tone: string;
  instructions: string;
  forbidden_words: string[];
}

export interface RecommendationDraftItem {
  product_id: string;
  reason: string;
  marketing_copy: string;
}

export interface RecommendationRequest {
  user_id: string;
  num_items?: number;
  context?: UserContext;
}

export interface RecommendedProduct {
  product_id: string;
  name: string;
  category: string;
  price_cents: number;
  brand: string;
  stock: number;
  tags: string[];
  score: number;
  low_stock: boolean;
  reason: string;
  marketing_copy: string;
}
