package agent

import (
	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

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
