package agent

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

// ToolRuntime 语义：执行主 Agent Model Tool，写入 Evidence，并投影结果给 Model。
// Harness Step（profile/search/inventory）由 Orchestrator 预取，不在此执行。

func (e *Executor) executeTool(call ToolCall, requestContext models.RequestContext, ev *Evidence) (string, error) {
	switch call.Function.Name {
	case "retrieve_knowledge":
		return e.executeRetrieveKnowledge(call, requestContext, ev)
	case "get_marketing_strategy":
		return e.executeMarketingStrategy(ev)
	default:
		return "", fmt.Errorf("unknown_tool")
	}
}

func (e *Executor) executeRetrieveKnowledge(call ToolCall, requestContext models.RequestContext, ev *Evidence) (string, error) {
	var args struct {
		Query string         `json:"query"`
		Limit int            `json:"limit"`
		Scope KnowledgeScope `json:"scope"`
	}
	if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
		return "", err
	}
	if args.Limit < 1 {
		args.Limit = 5
	}
	var categories []string
	var productIDs []string
	if args.Scope == ScopeProduct {
		if requestContext.Recommendation == nil {
			return "", fmt.Errorf("recommendation_context_not_prepared")
		}
		if ev.Profile == nil {
			return "", fmt.Errorf("profile_not_loaded")
		}
		explicit := requestContext.Recommendation.Request.Context.PreferredCategories
		if len(explicit) > 0 {
			categories = explicit
		} else {
			categories = ev.Profile.PreferredCategories
		}
		productIDs = append([]string{}, ev.InStockProductOrder...)
	}
	hits, err := e.Catalog.RetrieveKnowledge(args.Query, categories, productIDs, args.Limit)
	if err != nil {
		return "", err
	}
	grounded := map[string]struct{}{}
	genericCats := map[string]struct{}{}
	if args.Scope == ScopeProduct {
		for _, hit := range hits {
			if hit.ProductID != nil {
				grounded[*hit.ProductID] = struct{}{}
			} else {
				genericCats[hit.Category] = struct{}{}
			}
		}
		inv, err := e.Catalog.Inventory(productIDs)
		if err != nil {
			return "", err
		}
		for _, p := range inv {
			if _, ok := genericCats[p.Category]; ok {
				grounded[p.ProductID] = struct{}{}
			}
		}
	}
	var groundedIDs []string
	for id := range grounded {
		groundedIDs = append(groundedIDs, id)
	}
	sort.Strings(groundedIDs)
	RecordKnowledge(ev, hits, groundedIDs, args.Scope)
	projected := ProjectKnowledgeHitsForModel(hits, e.Budget)
	return ProjectToolResult("retrieve_knowledge", projected), nil
}

func (e *Executor) executeMarketingStrategy(ev *Evidence) (string, error) {
	if ev.Profile == nil {
		return "", fmt.Errorf("profile_not_loaded")
	}
	strategy, err := e.Catalog.MarketingStrategy(string(ev.Profile.Segment))
	if err != nil {
		return "", err
	}
	ev.UsedTools = append(ev.UsedTools, "get_marketing_strategy")
	b, _ := json.Marshal(strategy)
	return ProjectToolResult("get_marketing_strategy", string(b)), nil
}
