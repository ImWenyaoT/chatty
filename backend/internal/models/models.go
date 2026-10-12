package models

// 业务对象形状；字段名保持 snake_case，与 SQLite / HTTP 契约一致。

type UserSegment string

const (
	SegmentNewUser        UserSegment = "new_user"
	SegmentActive         UserSegment = "active"
	SegmentHighValue      UserSegment = "high_value"
	SegmentPriceSensitive UserSegment = "price_sensitive"
	SegmentChurnRisk      UserSegment = "churn_risk"
)

type Product struct {
	ProductID       string   `json:"product_id"`
	Name            string   `json:"name"`
	Category        string   `json:"category"`
	PriceCents      int      `json:"price_cents"`
	Description     string   `json:"description"`
	Brand           string   `json:"brand"`
	SellerID        string   `json:"seller_id"`
	Stock           int      `json:"stock"`
	Tags            []string `json:"tags"`
	PopularityScore float64  `json:"popularity_score"`
	ImageURL        string   `json:"image_url"`
	Source          string   `json:"source"`
}

type UserContext struct {
	RecentViews         []string `json:"recent_views"`
	RecentPurchases     []string `json:"recent_purchases"`
	PreferredCategories []string `json:"preferred_categories"`
	MinPriceCents       *int     `json:"min_price_cents"`
	MaxPriceCents       *int     `json:"max_price_cents"`
}

func EmptyUserContext() UserContext {
	return UserContext{}
}

type ProductNeed struct {
	Category *string  `json:"category"`
	MinYuan  *float64 `json:"min_yuan"`
	MaxYuan  *float64 `json:"max_yuan"`
}

type ParsedRequest struct {
	ProductNeed    *ProductNeed `json:"product_need"`
	KnowledgeQuery *string      `json:"knowledge_query"`
}

type UserProfile struct {
	UserID              string      `json:"user_id"`
	Segment             UserSegment `json:"segment"`
	PreferredCategories []string    `json:"preferred_categories"`
	MinPriceCents       int         `json:"min_price_cents"`
	MaxPriceCents       int         `json:"max_price_cents"`
	RecentViews         []string    `json:"recent_views"`
	RecentPurchases     []string    `json:"recent_purchases"`
}

type KnowledgeHit struct {
	DocID          string  `json:"doc_id"`
	Title          string  `json:"title"`
	Content        string  `json:"content"`
	Category       string  `json:"category"`
	ProductID      *string `json:"product_id"`
	Source         string  `json:"source"`
	ChunkOrdinal   int     `json:"chunk_ordinal"`
	RelevanceScore float64 `json:"relevance_score"`
}

type MarketingStrategy struct {
	Segment        UserSegment `json:"segment"`
	Tone           string      `json:"tone"`
	Instructions   string      `json:"instructions"`
	ForbiddenWords []string    `json:"forbidden_words"`
}

type RecommendationDraftItem struct {
	ProductID      string `json:"product_id"`
	Reason         string `json:"reason"`
	MarketingCopy  string `json:"marketing_copy"`
}

type RecommendationRequest struct {
	UserID   string      `json:"user_id"`
	NumItems int         `json:"num_items"`
	Context  UserContext `json:"context"`
}

type RecommendationContext struct {
	Request    RecommendationRequest `json:"request"`
	Profile    UserProfile           `json:"profile"`
	Candidates []Product             `json:"candidates"`
	Inventory  []Product             `json:"inventory"`
}

type RequestContext struct {
	Request        ParsedRequest          `json:"request"`
	Recommendation *RecommendationContext `json:"recommendation"`
}

type RecommendedProduct struct {
	ProductID     string   `json:"product_id"`
	Name          string   `json:"name"`
	Category      string   `json:"category"`
	PriceCents    int      `json:"price_cents"`
	Brand         string   `json:"brand"`
	Stock         int      `json:"stock"`
	Tags          []string `json:"tags"`
	LowStock      bool     `json:"low_stock"`
	Reason        string   `json:"reason"`
	MarketingCopy string   `json:"marketing_copy"`
}

type DraftAction string

const (
	ActionAnswer    DraftAction = "answer"
	ActionClarify   DraftAction = "clarify"
	ActionRecommend DraftAction = "recommend"
)

type AgentDraft struct {
	Action          DraftAction               `json:"action"`
	Answer          *string                   `json:"answer"`
	Question        *string                   `json:"question"`
	Recommendations []RecommendationDraftItem `json:"recommendations"`
}

type ReplyKind string

const (
	ReplyRecommend ReplyKind = "recommend"
	ReplyClarify   ReplyKind = "clarify"
	ReplyAnswer    ReplyKind = "answer"
)

type Reply struct {
	Kind     ReplyKind             `json:"kind"`
	Products []RecommendedProduct  `json:"products,omitempty"`
	Question string                `json:"question,omitempty"`
	Answer   *string               `json:"answer,omitempty"`
}

type DemoUser struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	DisplayName  string `json:"display_name"`
	ProfileLabel string `json:"profile_label"`
}

var DemoUsers = []DemoUser{
	{ID: "user_active", Label: "用户 A · 活跃型", DisplayName: "用户 A", ProfileLabel: "活跃型"},
	{ID: "user_budget", Label: "用户 B · 价格敏感型", DisplayName: "用户 B", ProfileLabel: "价格敏感型"},
	{ID: "user_vip", Label: "用户 C · 高价值型", DisplayName: "用户 C", ProfileLabel: "高价值型"},
	{ID: "user_new", Label: "用户 D · 新客型", DisplayName: "用户 D", ProfileLabel: "新客型"},
	{ID: "user_churn", Label: "用户 E · 流失风险型", DisplayName: "用户 E", ProfileLabel: "流失风险型"},
}

func DemoUserIDs() map[string]struct{} {
	ids := make(map[string]struct{}, len(DemoUsers))
	for _, u := range DemoUsers {
		ids[u.ID] = struct{}{}
	}
	return ids
}
