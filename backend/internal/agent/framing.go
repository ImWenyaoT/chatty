package agent

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

type RequestParseError string

func (e RequestParseError) Error() string { return string(e) }

type RequestParseOutput struct {
	ProductRequested bool     `json:"product_requested"`
	Category         *string  `json:"category"`
	MinYuan          *float64 `json:"min_yuan"`
	MaxYuan          *float64 `json:"max_yuan"`
	KnowledgeQuery   *string  `json:"knowledge_query"`
}

func ParseRequestOutput(raw string) (RequestParseOutput, error) {
	raw = extractJSONObject(raw)
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return RequestParseOutput{}, RequestParseError("invalid_request_parse_output")
	}
	obj, ok := value.(map[string]any)
	if !ok {
		return RequestParseOutput{}, RequestParseError("invalid_request_parse_output")
	}
	if props, ok := obj["properties"].(map[string]any); ok {
		obj = props
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return RequestParseOutput{}, RequestParseError("invalid_request_parse_output")
	}
	var out RequestParseOutput
	if err := json.Unmarshal(b, &out); err != nil {
		return RequestParseOutput{}, RequestParseError("invalid_request_parse_output")
	}
	return out, nil
}

func ParseRequest(output RequestParseOutput, categories []string) (models.ParsedRequest, error) {
	var category *string
	if output.Category != nil {
		c := strings.TrimSpace(*output.Category)
		if c != "" {
			category = &c
		}
	}
	var productNeed *models.ProductNeed
	if output.ProductRequested {
		if category != nil && !containsStr(categories, *category) {
			return models.ParsedRequest{}, RequestParseError("invalid_product_category")
		}
		if output.MinYuan != nil && output.MaxYuan != nil && *output.MinYuan > *output.MaxYuan {
			return models.ParsedRequest{}, RequestParseError("invalid_product_price_range")
		}
		productNeed = &models.ProductNeed{
			Category: category,
			MinYuan:  output.MinYuan,
			MaxYuan:  output.MaxYuan,
		}
	} else {
		if category != nil || output.MinYuan != nil || output.MaxYuan != nil {
			return models.ParsedRequest{}, RequestParseError("product_fields_without_request")
		}
	}
	var knowledgeQuery *string
	if output.KnowledgeQuery != nil {
		q := strings.TrimSpace(*output.KnowledgeQuery)
		if q != "" {
			knowledgeQuery = &q
		}
	}
	if productNeed == nil && knowledgeQuery == nil {
		return models.ParsedRequest{}, RequestParseError("empty_request")
	}
	return models.ParsedRequest{ProductNeed: productNeed, KnowledgeQuery: knowledgeQuery}, nil
}

func ProductContext(need models.ProductNeed) models.UserContext {
	ctx := models.EmptyUserContext()
	if need.Category != nil {
		ctx.PreferredCategories = []string{*need.Category}
	}
	if need.MinYuan != nil {
		v := int(math.Round(*need.MinYuan * 100))
		ctx.MinPriceCents = &v
	}
	if need.MaxYuan != nil {
		v := int(math.Round(*need.MaxYuan * 100))
		ctx.MaxPriceCents = &v
	}
	return ctx
}

func DescribeRequest(request models.ParsedRequest) string {
	var parts []string
	if need := request.ProductNeed; need != nil {
		if need.Category != nil && *need.Category != "" {
			parts = append(parts, *need.Category)
		} else {
			parts = append(parts, "不限类目")
		}
		if need.MinYuan != nil {
			parts = append(parts, fmt.Sprintf("≥%g 元", *need.MinYuan))
		}
		if need.MaxYuan != nil {
			parts = append(parts, fmt.Sprintf("≤%g 元", *need.MaxYuan))
		}
	}
	if request.KnowledgeQuery != nil {
		parts = append(parts, "知识 · "+*request.KnowledgeQuery)
	}
	return strings.Join(parts, " · ")
}

func containsStr(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
