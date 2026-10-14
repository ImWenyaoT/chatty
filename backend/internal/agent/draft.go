package agent

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

func parseAgentDraft(raw string, allowed []string) (models.AgentDraft, error) {
	raw = extractJSONObject(raw)
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

func extractJSONObject(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
	raw = strings.TrimSpace(raw)
	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start >= 0 && end > start {
		return raw[start : end+1]
	}
	return raw
}
