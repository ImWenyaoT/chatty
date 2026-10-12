package agent

import (
	"fmt"
	"sort"
	"strings"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

var harnessSteps = []string{"get_user_profile", "search_products", "check_inventory"}
var modelToolNames = []string{"get_marketing_strategy", "retrieve_knowledge"}
var toolNames = append(append([]string{}, harnessSteps...), modelToolNames...)
var dependencyChain = harnessSteps

type KnowledgeScope string

const (
	ScopeGeneral KnowledgeScope = "general"
	ScopeProduct KnowledgeScope = "product"
)

type Usage struct {
	Requests     int `json:"requests"`
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

func (u *Usage) Add(other Usage) {
	u.Requests += other.Requests
	u.InputTokens += other.InputTokens
	u.OutputTokens += other.OutputTokens
	u.TotalTokens += other.TotalTokens
}

type Evidence struct {
	Profile                   *models.UserProfile
	Knowledge                 []models.KnowledgeHit
	GeneralKnowledgeHits      int
	RecalledProductIDs        map[string]struct{}
	RecalledProductOrder      []string
	InStockProductIDs         map[string]struct{}
	InStockProductOrder       []string
	KnowledgeProductIDs       map[string]struct{}
	UsedTools                 []string
	BlockedAttempts           []string
	RequiredSupportTools      []string
	Usage                     Usage
	CompletedKnowledgeScopes  map[KnowledgeScope]struct{}
	AttemptedKnowledgeScopes  map[KnowledgeScope]int
	RequiredKnowledgeScopes   []KnowledgeScope
	AllowedFinalActions       []string
}

func NewEvidence() *Evidence {
	return &Evidence{
		RecalledProductIDs:       map[string]struct{}{},
		InStockProductIDs:        map[string]struct{}{},
		KnowledgeProductIDs:      map[string]struct{}{},
		CompletedKnowledgeScopes: map[KnowledgeScope]struct{}{},
		AttemptedKnowledgeScopes: map[KnowledgeScope]int{},
		RequiredSupportTools:     []string{"retrieve_knowledge", "get_marketing_strategy"},
	}
}

type EvidenceError struct {
	Code    string
	Missing []string
	Detail  string
}

func (e *EvidenceError) Error() string { return e.Code }

func RecordSearch(ev *Evidence, productIDs []string) {
	for _, id := range productIDs {
		if _, ok := ev.RecalledProductIDs[id]; !ok {
			ev.RecalledProductOrder = append(ev.RecalledProductOrder, id)
		}
		ev.RecalledProductIDs[id] = struct{}{}
	}
	ev.UsedTools = append(ev.UsedTools, "search_products")
}

func RecordInventory(ev *Evidence, productIDs []string) {
	for _, id := range productIDs {
		if _, ok := ev.InStockProductIDs[id]; !ok {
			ev.InStockProductOrder = append(ev.InStockProductOrder, id)
		}
		ev.InStockProductIDs[id] = struct{}{}
	}
	ev.UsedTools = append(ev.UsedTools, "check_inventory")
}

func RecordKnowledge(ev *Evidence, hits []models.KnowledgeHit, grounded []string, scope KnowledgeScope) {
	ev.Knowledge = append(ev.Knowledge, hits...)
	if len(hits) > 0 {
		ev.CompletedKnowledgeScopes[scope] = struct{}{}
	}
	ev.AttemptedKnowledgeScopes[scope]++
	if scope == ScopeGeneral {
		ev.GeneralKnowledgeHits += len(hits)
	}
	for _, id := range grounded {
		ev.KnowledgeProductIDs[id] = struct{}{}
	}
	ev.UsedTools = append(ev.UsedTools, "retrieve_knowledge")
}

func validateToolSequence(used []string) string {
	expected := map[string]struct{}{}
	for _, t := range toolNames {
		expected[t] = struct{}{}
	}
	actual := map[string]struct{}{}
	for _, t := range used {
		actual[t] = struct{}{}
	}
	var missing []string
	for t := range expected {
		if _, ok := actual[t]; !ok {
			missing = append(missing, t)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		return "未调用的工具：" + strings.Join(missing, ", ")
	}
	var unknown []string
	for t := range actual {
		if _, ok := expected[t]; !ok {
			unknown = append(unknown, t)
		}
	}
	sort.Strings(unknown)
	if len(unknown) > 0 {
		return "调用了未注册的工具：" + strings.Join(unknown, ", ")
	}
	for i := 1; i < len(dependencyChain); i++ {
		prev := indexOf(used, dependencyChain[i-1])
		cur := indexOf(used, dependencyChain[i])
		if cur < prev {
			return fmt.Sprintf("依赖顺序错误，应为 %s", strings.Join(dependencyChain, " -> "))
		}
	}
	return ""
}

func indexOf(xs []string, v string) int {
	for i, x := range xs {
		if x == v {
			return i
		}
	}
	return -1
}

func ValidateRecommendationEvidence(ev *Evidence, draft []models.RecommendationDraftItem) error {
	if msg := validateToolSequence(ev.UsedTools); msg != "" {
		return &EvidenceError{Code: "required_tools_not_used", Detail: msg}
	}
	if len(ev.Knowledge) == 0 {
		return &EvidenceError{Code: "knowledge_not_retrieved"}
	}
	if ev.Profile == nil {
		return &EvidenceError{Code: "profile_not_loaded"}
	}
	recommended := map[string]struct{}{}
	for _, item := range draft {
		recommended[item.ProductID] = struct{}{}
	}
	checks := []struct {
		code string
		set  map[string]struct{}
	}{
		{"product_not_recalled", ev.RecalledProductIDs},
		{"inventory_not_checked", ev.InStockProductIDs},
		{"product_not_grounded", ev.KnowledgeProductIDs},
	}
	for _, check := range checks {
		var missing []string
		for id := range recommended {
			if _, ok := check.set[id]; !ok {
				missing = append(missing, id)
			}
		}
		sort.Strings(missing)
		if len(missing) > 0 {
			return &EvidenceError{Code: check.code, Missing: missing}
		}
	}
	return nil
}

func ValidateClarificationEvidence(ev *Evidence) error {
	if msg := validateToolSequence(ev.UsedTools); msg != "" {
		return &EvidenceError{Code: "required_tools_not_used", Detail: msg}
	}
	if len(ev.InStockProductIDs) > 0 {
		return &EvidenceError{Code: "invalid_recommendation"}
	}
	return nil
}
