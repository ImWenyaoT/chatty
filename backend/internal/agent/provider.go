package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type ChatMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolDef struct {
	Type     string         `json:"type"`
	Function ToolDefFunc    `json:"function"`
}

type ToolDefFunc struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type Provider struct {
	APIKey  string
	BaseURL string
	ModelID string
	Client  *http.Client
}

func NewProvider(apiKey, baseURL, modelID string) *Provider {
	return &Provider{
		APIKey:  apiKey,
		BaseURL: strings.TrimRight(baseURL, "/"),
		ModelID: modelID,
		Client:  &http.Client{Timeout: 120 * time.Second},
	}
}

func (p *Provider) Configured() bool {
	return strings.TrimSpace(p.APIKey) != ""
}

type completionRequest struct {
	Model       string       `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Tools       []ToolDef    `json:"tools,omitempty"`
	ToolChoice  any          `json:"tool_choice,omitempty"`
	Temperature float64      `json:"temperature,omitempty"`
}

type completionResponse struct {
	Choices []struct {
		Message ChatMessage `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

func (p *Provider) Chat(ctx context.Context, messages []ChatMessage, tools []ToolDef, toolChoice any) (ChatMessage, Usage, error) {
	if !p.Configured() {
		return ChatMessage{}, Usage{}, fmt.Errorf("llm_not_configured")
	}
	body := completionRequest{
		Model:       p.ModelID,
		Messages:    messages,
		Tools:       tools,
		ToolChoice:  toolChoice,
		Temperature: 0.2,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return ChatMessage{}, Usage{}, err
	}
	url := p.BaseURL + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return ChatMessage{}, Usage{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.Client.Do(req)
	if err != nil {
		return ChatMessage{}, Usage{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return ChatMessage{}, Usage{}, err
	}
	if resp.StatusCode >= 300 {
		return ChatMessage{}, Usage{}, fmt.Errorf("llm_http_%d: %s", resp.StatusCode, truncate(string(data), 400))
	}
	var parsed completionResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return ChatMessage{}, Usage{}, err
	}
	if len(parsed.Choices) == 0 {
		return ChatMessage{}, Usage{}, fmt.Errorf("llm_empty_choices")
	}
	usage := Usage{
		Requests:     1,
		InputTokens:  parsed.Usage.PromptTokens,
		OutputTokens: parsed.Usage.CompletionTokens,
		TotalTokens:  parsed.Usage.TotalTokens,
	}
	return parsed.Choices[0].Message, usage, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
