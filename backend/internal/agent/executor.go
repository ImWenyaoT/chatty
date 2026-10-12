package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

type RecommendationError struct {
	Code        string
	Diagnostics map[string]any
}

func (e *RecommendationError) Error() string { return e.Code }

type Executor struct {
	Catalog  *catalog.Catalog
	Provider *Provider
	Prompts  string
}

func PrepareRecommendationContext(request models.RecommendationRequest, cat *catalog.Catalog, ev *Evidence) (models.RecommendationContext, error) {
	profile, err := cat.UserProfile(request.UserID, request.Context)
	if err != nil {
		return models.RecommendationContext{}, err
	}
	ev.Profile = &profile
	ev.UsedTools = append(ev.UsedTools, "get_user_profile")
	candidates, err := cat.Search(profile, profile.PreferredCategories, profile.MinPriceCents, profile.MaxPriceCents, 10)
	if err != nil {
		return models.RecommendationContext{}, err
	}
	ids := make([]string, len(candidates))
	for i, p := range candidates {
		ids[i] = p.ProductID
	}
	RecordSearch(ev, ids)
	inventory, err := cat.Inventory(ev.RecalledProductOrder)
	if err != nil {
		return models.RecommendationContext{}, err
	}
	invIDs := make([]string, len(inventory))
	for i, p := range inventory {
		invIDs[i] = p.ProductID
	}
	RecordInventory(ev, invIDs)
	return models.RecommendationContext{
		Request:    request,
		Profile:    profile,
		Candidates: candidates,
		Inventory:  inventory,
	}, nil
}

func PrepareRequestContext(request models.ParsedRequest, userID string, cat *catalog.Catalog, ev *Evidence) (models.RequestContext, error) {
	var recommendation *models.RecommendationContext
	if request.ProductNeed != nil {
		recReq := models.RecommendationRequest{
			UserID:   userID,
			NumItems: 3,
			Context:  ProductContext(*request.ProductNeed),
		}
		rec, err := PrepareRecommendationContext(recReq, cat, ev)
		if err != nil {
			return models.RequestContext{}, err
		}
		recommendation = &rec
	}
	if recommendation == nil {
		ev.RequiredSupportTools = []string{"retrieve_knowledge"}
	}
	var scopes []KnowledgeScope
	if request.KnowledgeQuery != nil {
		scopes = append(scopes, ScopeGeneral)
	}
	if request.ProductNeed != nil {
		scopes = append(scopes, ScopeProduct)
	}
	ev.RequiredKnowledgeScopes = scopes
	if recommendation == nil {
		ev.AllowedFinalActions = []string{"answer"}
	} else {
		ev.AllowedFinalActions = []string{"recommend", "clarify"}
	}
	return models.RequestContext{Request: request, Recommendation: recommendation}, nil
}

func (e *Executor) Respond(ctx context.Context, requestContext models.RequestContext, ev *Evidence, userText string, history []ChatMessage) (models.Reply, error) {
	draft, err := e.generateDraft(ctx, requestContext, ev, userText, history)
	if err != nil {
		return models.Reply{}, err
	}
	return e.finalizeReply(requestContext, ev, draft)
}

func (e *Executor) generateDraft(ctx context.Context, requestContext models.RequestContext, ev *Evidence, userText string, history []ChatMessage) (models.AgentDraft, error) {
	instructions, err := os.ReadFile(filepath.Join(e.Prompts, "instructions.md"))
	if err != nil {
		return models.AgentDraft{}, err
	}
	messages := append([]ChatMessage{}, history...)
	messages = append(messages,
		ChatMessage{Role: "system", Content: string(instructions)},
		ChatMessage{Role: "user", Content: userText},
	)
	harnessJSON, _ := json.Marshal(requestContext)
	messages = append(messages, ChatMessage{
		Role:    "system",
		Content: "<harness_context>\n" + string(harnessJSON) + "\n</harness_context>",
	})

	tools := toolDefinitions()
	toolChoice := any("required")
	for turn := 0; turn < 12; turn++ {
		status := RenderAgentStatus(ev)
		roundMsgs := append(append([]ChatMessage{}, messages...), ChatMessage{Role: "system", Content: status})
		if StageFor(ev) == StageReadyToDraft {
			toolChoice = "auto"
		}
		msg, usage, err := e.Provider.Chat(ctx, roundMsgs, tools, toolChoice)
		if err != nil {
			return models.AgentDraft{}, err
		}
		ev.Usage.Add(usage)
		if len(msg.ToolCalls) == 0 {
			draft, err := parseAgentDraft(msg.Content, ev.AllowedFinalActions)
			if err != nil {
				corrected, cerr := e.correctDraft(ctx, msg.Content, ev.AllowedFinalActions)
				if cerr != nil {
					return models.AgentDraft{}, &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "correction_failed", "cause": cerr.Error()}}
				}
				return corrected, nil
			}
			return draft, nil
		}
		messages = append(messages, msg)
		batch := OpenToolBatch(ev)
		for _, call := range msg.ToolCalls {
			decision := GateToolCall(batch, call.Function.Name)
			if !decision.Allowed {
				ev.BlockedAttempts = append(ev.BlockedAttempts, fmt.Sprintf("%s:%s:%s", batch.Stage, call.Function.Name, decision.Reason))
				payload, _ := json.Marshal(map[string]any{
					"status":       "blocked",
					"reason":       decision.Reason,
					"required_next": AllowedTools(ev),
					"agent_status": RenderAgentStatus(ev),
				})
				messages = append(messages, ChatMessage{
					Role:       "tool",
					ToolCallID: call.ID,
					Name:       call.Function.Name,
					Content:    string(payload),
				})
				continue
			}
			result, err := e.executeTool(call, requestContext, ev)
			if err != nil {
				result = fmt.Sprintf(`{"error":%q}`, err.Error())
			}
			messages = append(messages, ChatMessage{
				Role:       "tool",
				ToolCallID: call.ID,
				Name:       call.Function.Name,
				Content:    result,
			})
		}
		toolChoice = "auto"
	}
	return models.AgentDraft{}, &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "max_turns_exceeded"}}
}

func (e *Executor) correctDraft(ctx context.Context, raw string, allowed []string) (models.AgentDraft, error) {
	prompt, err := os.ReadFile(filepath.Join(e.Prompts, "draft_corrector.md"))
	if err != nil {
		return models.AgentDraft{}, err
	}
	messages := []ChatMessage{
		{Role: "system", Content: string(prompt) + "\nAllowed actions: " + strings.Join(allowed, ", ")},
		{Role: "user", Content: raw},
	}
	msg, usage, err := e.Provider.Chat(ctx, messages, nil, nil)
	if err != nil {
		return models.AgentDraft{}, err
	}
	// usage counted by caller via evidence? add here through side channel — caller should add
	_ = usage
	return parseAgentDraft(msg.Content, allowed)
}

func (e *Executor) executeTool(call ToolCall, requestContext models.RequestContext, ev *Evidence) (string, error) {
	switch call.Function.Name {
	case "retrieve_knowledge":
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
		b, _ := json.Marshal(hits)
		return string(b), nil
	case "get_marketing_strategy":
		if ev.Profile == nil {
			return "", fmt.Errorf("profile_not_loaded")
		}
		strategy, err := e.Catalog.MarketingStrategy(string(ev.Profile.Segment))
		if err != nil {
			return "", err
		}
		ev.UsedTools = append(ev.UsedTools, "get_marketing_strategy")
		b, _ := json.Marshal(strategy)
		return string(b), nil
	default:
		return "", fmt.Errorf("unknown_tool")
	}
}

func (e *Executor) finalizeReply(requestContext models.RequestContext, ev *Evidence, draft models.AgentDraft) (models.Reply, error) {
	recommendation := requestContext.Recommendation
	if err := validateKnowledgeAnswer(requestContext, ev, draft.Answer, string(draft.Action)); err != nil {
		return models.Reply{}, err
	}
	switch draft.Action {
	case models.ActionAnswer:
		if requestContext.Request.KnowledgeQuery == nil || recommendation != nil || draft.Answer == nil {
			return models.Reply{}, &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "answer_action_not_allowed"}}
		}
		return models.Reply{Kind: models.ReplyAnswer, Answer: draft.Answer}, nil
	case models.ActionClarify:
		if recommendation == nil || draft.Question == nil {
			return models.Reply{}, &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "clarify_not_allowed"}}
		}
		if err := ValidateClarificationEvidence(ev); err != nil {
			if ee, ok := err.(*EvidenceError); ok {
				return models.Reply{}, &RecommendationError{Code: ee.Code, Diagnostics: map[string]any{"detail": ee.Detail, "missing": ee.Missing}}
			}
			return models.Reply{}, err
		}
		return models.Reply{Kind: models.ReplyClarify, Question: *draft.Question, Answer: draft.Answer}, nil
	case models.ActionRecommend:
		if recommendation == nil || len(draft.Recommendations) == 0 {
			return models.Reply{}, &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "recommend_not_allowed"}}
		}
		if err := ValidateRecommendationEvidence(ev, draft.Recommendations); err != nil {
			if ee, ok := err.(*EvidenceError); ok {
				return models.Reply{}, &RecommendationError{Code: ee.Code, Diagnostics: map[string]any{"detail": ee.Detail, "missing": ee.Missing}}
			}
			return models.Reply{}, err
		}
		if ev.Profile == nil {
			return models.Reply{}, &RecommendationError{Code: "profile_not_loaded"}
		}
		products, err := e.Catalog.Finalize(draft.Recommendations, recommendation.Request, *ev.Profile)
		if err != nil {
			if ce, ok := err.(catalog.Error); ok {
				return models.Reply{}, &RecommendationError{Code: string(ce)}
			}
			return models.Reply{}, err
		}
		_ = e.Catalog.UpdateUserProfileAfterSuccess(recommendation.Request.UserID, recommendation.Request.Context.PreferredCategories)
		return models.Reply{Kind: models.ReplyRecommend, Products: products, Answer: draft.Answer}, nil
	default:
		return models.Reply{}, &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "unknown_action"}}
	}
}

func validateKnowledgeAnswer(requestContext models.RequestContext, ev *Evidence, answer *string, draftAction string) error {
	if requestContext.Request.KnowledgeQuery == nil {
		return nil
	}
	if answer == nil || strings.TrimSpace(*answer) == "" {
		return &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "knowledge_answer_missing", "draft_action": draftAction}}
	}
	generalCalls := knowledgeCallCount(ev, ScopeGeneral)
	exhausted := generalCalls >= MaxKnowledgeCallsPerScope
	if ev.GeneralKnowledgeHits == 0 && !exhausted {
		return &RecommendationError{Code: "knowledge_not_retrieved", Diagnostics: map[string]any{"reason": "answered_without_retrieval", "knowledge_calls": generalCalls}}
	}
	return nil
}

func parseAgentDraft(raw string, allowed []string) (models.AgentDraft, error) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return models.AgentDraft{}, err
	}
	if obj, ok := value.(map[string]any); ok {
		if props, ok := obj["properties"].(map[string]any); ok {
			value = props
		}
	}
	b, _ := json.Marshal(value)
	var draft models.AgentDraft
	if err := json.Unmarshal(b, &draft); err != nil {
		return models.AgentDraft{}, err
	}
	if len(allowed) > 0 {
		ok := false
		for _, a := range allowed {
			if string(draft.Action) == a {
				ok = true
				break
			}
		}
		if !ok {
			return models.AgentDraft{}, fmt.Errorf("action_not_allowed")
		}
	}
	switch draft.Action {
	case models.ActionAnswer:
		if draft.Answer == nil || strings.TrimSpace(*draft.Answer) == "" {
			return models.AgentDraft{}, fmt.Errorf("answer_required")
		}
	case models.ActionClarify:
		if draft.Question == nil || strings.TrimSpace(*draft.Question) == "" {
			return models.AgentDraft{}, fmt.Errorf("clarify_question_required")
		}
	case models.ActionRecommend:
		if len(draft.Recommendations) == 0 {
			return models.AgentDraft{}, fmt.Errorf("recommendations_required")
		}
	default:
		return models.AgentDraft{}, fmt.Errorf("unknown_action")
	}
	return draft, nil
}

func toolDefinitions() []ToolDef {
	return []ToolDef{
		{
			Type: "function",
			Function: ToolDefFunc{
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
		},
		{
			Type: "function",
			Function: ToolDefFunc{
				Name:        "get_marketing_strategy",
				Description: "获取画像分群对应的营销语气、写作要求与禁用词。",
				Parameters: map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
		},
	}
}
