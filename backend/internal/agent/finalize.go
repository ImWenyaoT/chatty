package agent

import (
	"strings"

	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

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
