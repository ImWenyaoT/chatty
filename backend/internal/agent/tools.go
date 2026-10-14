package agent

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

// modelTool 是主 Agent 可见 Tool 的轻量合同（非 Agent）。
// Harness Subagent（request_parser / draft_corrector）不得出现在此表。
type modelTool struct {
	Name        string
	Description string
	Parameters  map[string]any
}

var modelTools = []modelTool{
	{
		Name:        "retrieve_knowledge",
		Description: "检索政策或商品知识。知识问题使用 general；商品推荐使用 product。0 命中时改写 query 后重试，不要原样重复。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "关键词查询。"},
				"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 8},
				"scope": map[string]any{"type": "string", "enum": []string{"general", "product"}},
			},
			"required": []string{"query", "limit", "scope"},
		},
	},
	{
		Name:        "get_marketing_strategy",
		Description: "获取画像分群对应的营销语气、写作要求与禁用词。",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	},
}

// ToolDefinitions 转为 Provider Chat Completions 的 tools 载荷。
func ToolDefinitions() []ToolDef {
	out := make([]ToolDef, len(modelTools))
	for i, t := range modelTools {
		out[i] = ToolDef{
			Type: "function",
			Function: ToolDefFunc{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.Parameters,
			},
		}
	}
	return out
}

func modelToolNameSet() map[string]struct{} {
	set := make(map[string]struct{}, len(modelTools))
	for _, t := range modelTools {
		set[t.Name] = struct{}{}
	}
	return set
}

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
	// Evidence 保留完整 hits；进 Model 的是投影后的合法 JSON。
	return ProjectKnowledgeHitsForModel(hits, e.Budget), nil
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
	b, err := json.Marshal(strategy)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
