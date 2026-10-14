package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

func TestProjectHarnessContextBudgetAndWhitelist(t *testing.T) {
	longDesc := strings.Repeat("描", 200)
	products := make([]models.Product, 12)
	for i := range products {
		products[i] = models.Product{
			ProductID:   fmt.Sprintf("P%d", i+1),
			Name:        "商品",
			Category:    "耳机",
			PriceCents:  1000,
			Brand:       "B",
			Stock:       3,
			Tags:        []string{"t"},
			Description: longDesc,
			ImageURL:    "http://example/x.png",
			SellerID:    "s1",
			Source:      "seed",
		}
	}
	rc := models.RequestContext{
		Request: models.ParsedRequest{ProductNeed: &models.ProductNeed{}},
		Recommendation: &models.RecommendationContext{
			Request: models.RecommendationRequest{
				UserID:   "u1",
				NumItems: 3,
				Context: models.UserContext{
					RecentViews:         []string{"a", "b", "c", "d", "e", "f"},
					RecentPurchases:     []string{"x", "y", "z"},
					PreferredCategories: []string{"耳机"},
				},
			},
			Profile: models.UserProfile{
				UserID:          "u1",
				Segment:         models.SegmentActive,
				RecentViews:     []string{"a", "b", "c", "d", "e", "f"},
				RecentPurchases: []string{"x", "y"},
			},
			Candidates: products,
			Inventory:  products[:3],
		},
	}
	budget := DefaultContextBudget()
	budget.MaxCandidates = 5
	budget.MaxCandidateDescChars = 20
	budget.MaxRecentIDs = 3

	view := ProjectHarnessContext(rc, budget)
	if view.Source != "sqlite_catalog" {
		t.Fatalf("source=%q", view.Source)
	}
	if view.Recommendation == nil {
		t.Fatal("nil recommendation projection")
	}
	if len(view.Recommendation.Candidates) != 5 {
		t.Fatalf("candidates=%d", len(view.Recommendation.Candidates))
	}
	if len(view.Recommendation.Profile.RecentViews) != 3 {
		t.Fatalf("recent_views=%d", len(view.Recommendation.Profile.RecentViews))
	}
	if view.Recommendation.Request.UserID != "u1" || view.Recommendation.Request.NumItems != 3 {
		t.Fatalf("request projection=%+v", view.Recommendation.Request)
	}
	c0 := view.Recommendation.Candidates[0]
	if c0.Description == longDesc {
		t.Fatal("description should be truncated")
	}
	raw, _ := json.Marshal(view)
	s := string(raw)
	if strings.Contains(s, "image_url") || strings.Contains(s, "seller_id") || strings.Contains(s, "popularity_score") {
		t.Fatalf("noise fields leaked into harness_context: %s", s)
	}
	if strings.Contains(s, `"queried_at"`) {
		t.Fatal("queried_at removed until prepare-time stamp exists")
	}
	// request 投影不得再塞一份 uncapped recent_*
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	rec := decoded["recommendation"].(map[string]any)
	req := rec["request"].(map[string]any)
	if _, ok := req["context"]; ok {
		t.Fatal("recommendation.request must not embed full UserContext")
	}
	if _, ok := req["recent_views"]; ok {
		t.Fatal("recent_views must not appear under recommendation.request")
	}
}

func TestProjectKnowledgeHitsForModelTruncatesContent(t *testing.T) {
	hits := []models.KnowledgeHit{{
		DocID:   "d1",
		Title:   "政策",
		Content: strings.Repeat("文", 1000),
		Source:  "fts5",
	}}
	budget := DefaultContextBudget()
	budget.MaxKnowledgeContentChars = 50
	raw := ProjectKnowledgeHitsForModel(hits, budget)
	var out []map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	content, _ := out[0]["content"].(string)
	if len([]rune(content)) > 51 {
		t.Fatalf("content too long: %d", len([]rune(content)))
	}
	if strings.Contains(raw, "chunk_ordinal") {
		t.Fatal("chunk_ordinal should not be model-visible")
	}
}

func TestRenderHarnessContextXMLWraps(t *testing.T) {
	xml := RenderHarnessContextXML(models.RequestContext{
		Request: models.ParsedRequest{},
	}, DefaultContextBudget())
	if !strings.HasPrefix(xml, "<harness_context>") || !strings.HasSuffix(xml, "</harness_context>") {
		t.Fatalf("bad wrap: %q", xml)
	}
}
