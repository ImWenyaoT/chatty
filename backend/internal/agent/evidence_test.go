package agent

import (
	"testing"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

func TestValidateRecommendationEvidenceFailures(t *testing.T) {
	base := func() *Evidence {
		ev := NewEvidence()
		profile := models.UserProfile{UserID: "u1", Segment: models.SegmentActive}
		ev.Profile = &profile
		ev.UsedTools = []string{
			"get_user_profile", "search_products", "check_inventory",
			"retrieve_knowledge", "get_marketing_strategy",
		}
		ev.RecalledProductIDs = map[string]struct{}{"P001": {}, "P002": {}}
		ev.RecalledProductOrder = []string{"P001", "P002"}
		ev.InStockProductIDs = map[string]struct{}{"P001": {}, "P002": {}}
		ev.InStockProductOrder = []string{"P001", "P002"}
		ev.Knowledge = []models.KnowledgeHit{{DocID: "d1", Title: "t", Content: "c"}}
		ev.KnowledgeProductIDs = map[string]struct{}{"P001": {}, "P002": {}}
		return ev
	}
	draft := []models.RecommendationDraftItem{{ProductID: "P001", Reason: "r", MarketingCopy: "m"}}

	t.Run("ok", func(t *testing.T) {
		if err := ValidateRecommendationEvidence(base(), draft); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("missing_tool", func(t *testing.T) {
		ev := base()
		ev.UsedTools = []string{"get_user_profile", "search_products", "check_inventory"}
		err := ValidateRecommendationEvidence(ev, draft)
		ee, ok := err.(*EvidenceError)
		if !ok || ee.Code != "required_tools_not_used" {
			t.Fatalf("got %#v", err)
		}
	})

	t.Run("knowledge_empty", func(t *testing.T) {
		ev := base()
		ev.Knowledge = nil
		err := ValidateRecommendationEvidence(ev, draft)
		ee, ok := err.(*EvidenceError)
		if !ok || ee.Code != "knowledge_not_retrieved" {
			t.Fatalf("got %#v", err)
		}
	})

	t.Run("not_recalled", func(t *testing.T) {
		ev := base()
		err := ValidateRecommendationEvidence(ev, []models.RecommendationDraftItem{
			{ProductID: "P999", Reason: "r", MarketingCopy: "m"},
		})
		ee, ok := err.(*EvidenceError)
		if !ok || ee.Code != "product_not_recalled" {
			t.Fatalf("got %#v", err)
		}
	})

	t.Run("inventory_not_checked", func(t *testing.T) {
		ev := base()
		ev.InStockProductIDs = map[string]struct{}{}
		err := ValidateRecommendationEvidence(ev, draft)
		ee, ok := err.(*EvidenceError)
		if !ok || ee.Code != "inventory_not_checked" {
			t.Fatalf("got %#v", err)
		}
	})

	t.Run("not_grounded", func(t *testing.T) {
		ev := base()
		ev.KnowledgeProductIDs = map[string]struct{}{}
		err := ValidateRecommendationEvidence(ev, draft)
		ee, ok := err.(*EvidenceError)
		if !ok || ee.Code != "product_not_grounded" {
			t.Fatalf("got %#v", err)
		}
	})
}

func TestValidateClarificationEvidence(t *testing.T) {
	t.Run("ok_when_no_stock", func(t *testing.T) {
		ev := NewEvidence()
		ev.UsedTools = []string{
			"get_user_profile", "search_products", "check_inventory",
			"retrieve_knowledge", "get_marketing_strategy",
		}
		if err := ValidateClarificationEvidence(ev); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("invalid_when_stock_exists", func(t *testing.T) {
		ev := NewEvidence()
		ev.UsedTools = []string{
			"get_user_profile", "search_products", "check_inventory",
			"retrieve_knowledge", "get_marketing_strategy",
		}
		ev.InStockProductIDs["P001"] = struct{}{}
		err := ValidateClarificationEvidence(ev)
		ee, ok := err.(*EvidenceError)
		if !ok || ee.Code != "invalid_recommendation" {
			t.Fatalf("got %#v", err)
		}
	})
}
