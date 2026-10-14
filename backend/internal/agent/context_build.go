package agent

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

// ContextBudget 限制进入 Model 的动态 harness_context 体积。
type ContextBudget struct {
	MaxCandidates           int
	MaxInventory            int
	MaxRecentIDs            int
	MaxKnowledgeContentChars int
	MaxCandidateDescChars   int
}

func DefaultContextBudget() ContextBudget {
	return ContextBudget{
		MaxCandidates:            8,
		MaxInventory:             8,
		MaxRecentIDs:             5,
		MaxKnowledgeContentChars: 600,
		MaxCandidateDescChars:    120,
	}
}

// candidateProjection 白名单字段；不含 image_url / seller / popularity 等噪声。
type candidateProjection struct {
	ProductID   string   `json:"product_id"`
	Name        string   `json:"name"`
	Category    string   `json:"category"`
	PriceCents  int      `json:"price_cents"`
	Brand       string   `json:"brand"`
	Stock       int      `json:"stock"`
	Tags        []string `json:"tags"`
	Description string   `json:"description,omitempty"`
}

type profileProjection struct {
	UserID              string              `json:"user_id"`
	Segment             models.UserSegment  `json:"segment"`
	PreferredCategories []string            `json:"preferred_categories"`
	MinPriceCents       int                 `json:"min_price_cents"`
	MaxPriceCents       int                 `json:"max_price_cents"`
	RecentViews         []string            `json:"recent_views"`
	RecentPurchases     []string            `json:"recent_purchases"`
}

type recommendationProjection struct {
	Request    models.RecommendationRequest `json:"request"`
	Profile    profileProjection            `json:"profile"`
	Candidates []candidateProjection        `json:"candidates"`
	Inventory  []candidateProjection        `json:"inventory"`
}

// harnessContextView 是 model-visible 的动态 Context（非 Evidence 全量）。
type harnessContextView struct {
	Source         string                     `json:"source"`
	QueriedAt      string                     `json:"queried_at"`
	Request        models.ParsedRequest       `json:"request"`
	Recommendation *recommendationProjection  `json:"recommendation"`
}

// ProjectHarnessContext 将 RequestContext 投影为带预算与 provenance 的视图。
func ProjectHarnessContext(rc models.RequestContext, budget ContextBudget) harnessContextView {
	view := harnessContextView{
		Source:    "sqlite_catalog",
		QueriedAt: time.Now().UTC().Format(time.RFC3339),
		Request:   rc.Request,
	}
	if rc.Recommendation == nil {
		return view
	}
	rec := rc.Recommendation
	view.Recommendation = &recommendationProjection{
		Request: rec.Request,
		Profile: projectProfile(rec.Profile, budget),
		Candidates: projectProducts(rec.Candidates, budget.MaxCandidates, budget.MaxCandidateDescChars),
		Inventory:  projectProducts(rec.Inventory, budget.MaxInventory, budget.MaxCandidateDescChars),
	}
	return view
}

func projectProfile(p models.UserProfile, budget ContextBudget) profileProjection {
	return profileProjection{
		UserID:              p.UserID,
		Segment:             p.Segment,
		PreferredCategories: p.PreferredCategories,
		MinPriceCents:       p.MinPriceCents,
		MaxPriceCents:       p.MaxPriceCents,
		RecentViews:         truncateIDs(p.RecentViews, budget.MaxRecentIDs),
		RecentPurchases:     truncateIDs(p.RecentPurchases, budget.MaxRecentIDs),
	}
}

func projectProducts(products []models.Product, max int, descChars int) []candidateProjection {
	if max <= 0 || len(products) == 0 {
		return []candidateProjection{}
	}
	if len(products) < max {
		max = len(products)
	}
	out := make([]candidateProjection, 0, max)
	for i := 0; i < max; i++ {
		p := products[i]
		out = append(out, candidateProjection{
			ProductID:   p.ProductID,
			Name:        p.Name,
			Category:    p.Category,
			PriceCents:  p.PriceCents,
			Brand:       p.Brand,
			Stock:       p.Stock,
			Tags:        p.Tags,
			Description: truncateRunes(p.Description, descChars),
		})
	}
	return out
}

func truncateIDs(ids []string, max int) []string {
	if max <= 0 || len(ids) <= max {
		return ids
	}
	return ids[:max]
}

func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// RenderHarnessContextXML 装配 <harness_context> 系统消息内容。
func RenderHarnessContextXML(rc models.RequestContext, budget ContextBudget) string {
	view := ProjectHarnessContext(rc, budget)
	raw, err := json.Marshal(view)
	if err != nil {
		return "<harness_context>\n{}\n</harness_context>"
	}
	return "<harness_context>\n" + string(raw) + "\n</harness_context>"
}

// ProjectKnowledgeHitsForModel 裁剪知识命中进 Tool Result；Evidence 仍保留完整 hits。
func ProjectKnowledgeHitsForModel(hits []models.KnowledgeHit, budget ContextBudget) string {
	type hitView struct {
		DocID          string  `json:"doc_id"`
		Title          string  `json:"title"`
		Content        string  `json:"content"`
		Category       string  `json:"category"`
		ProductID      *string `json:"product_id"`
		Source         string  `json:"source"`
		RelevanceScore float64 `json:"relevance_score"`
	}
	views := make([]hitView, 0, len(hits))
	for _, h := range hits {
		views = append(views, hitView{
			DocID:          h.DocID,
			Title:          h.Title,
			Content:        truncateRunes(h.Content, budget.MaxKnowledgeContentChars),
			Category:       h.Category,
			ProductID:      h.ProductID,
			Source:         h.Source,
			RelevanceScore: h.RelevanceScore,
		})
	}
	b, err := json.Marshal(views)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// LoadStaticInstructions 读取稳定前缀 instructions（Static Context）。
func LoadStaticInstructions(promptsDir string) (string, error) {
	return readPromptFile(promptsDir, "instructions.md")
}

func buildInitialLoopMessages(instructions, userText string, history []ChatMessage, harnessXML string) []ChatMessage {
	messages := append([]ChatMessage{}, history...)
	messages = append(messages,
		ChatMessage{Role: "system", Content: instructions},
		ChatMessage{Role: "user", Content: userText},
		ChatMessage{Role: "system", Content: harnessXML},
	)
	return messages
}

func formatBlockedToolResult(batch *ToolBatch, ev *Evidence, reason string) string {
	payload, _ := json.Marshal(map[string]any{
		"status":        "blocked",
		"reason":        reason,
		"required_next": AllowedTools(ev),
		"agent_status":  RenderAgentStatus(ev),
		"stage":         string(batch.Stage),
	})
	return string(payload)
}

func formatToolError(err error) string {
	return fmt.Sprintf(`{"error":%q}`, err.Error())
}
