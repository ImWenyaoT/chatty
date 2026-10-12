package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

const MaxTurns = 3

type ChattyContext struct {
	PendingUserMessages []string      `json:"pending_user_messages"`
	History             []ChatMessage `json:"history"`
	Turns               int           `json:"turns"`
}

func NewChattyContext() ChattyContext {
	return ChattyContext{
		PendingUserMessages: []string{},
		History:             []ChatMessage{},
	}
}

type ChattyTurn struct {
	Reply        models.Reply  `json:"reply"`
	UnderstoodAs string        `json:"understood_as"`
	Context      ChattyContext `json:"context"`
	TurnsLeft    int           `json:"turns_left"`
	Trace        []string      `json:"trace"`
	Usage        Usage         `json:"usage"`
	LatencyMs    float64       `json:"latency_ms"`
}

type ChattyError struct {
	Code        string
	Diagnostics map[string]any
	Cause       error
}

func (e *ChattyError) Error() string { return e.Code }

type Agent interface {
	Run(ctx context.Context, userID, text string, chatCtx ChattyContext) (ChattyTurn, error)
}

type Chatty struct {
	Catalog  *catalog.Catalog
	Provider *Provider
	Executor *Executor
	Prompts  string
}

func NewChatty(cat *catalog.Catalog, provider *Provider, promptsDir string) *Chatty {
	return &Chatty{
		Catalog:  cat,
		Provider: provider,
		Prompts:  promptsDir,
		Executor: &Executor{Catalog: cat, Provider: provider, Prompts: promptsDir},
	}
}

func (c *Chatty) Run(ctx context.Context, userID, text string, chatCtx ChattyContext) (ChattyTurn, error) {
	started := time.Now()
	if chatCtx.Turns >= MaxTurns {
		return ChattyTurn{}, &ChattyError{Code: "conversation_exhausted"}
	}
	pending := append(append([]string{}, chatCtx.PendingUserMessages...), text)
	ev := NewEvidence()

	if !c.Provider.Configured() {
		return ChattyTurn{}, &ChattyError{Code: "llm_not_configured"}
	}

	parsedOutput, parseUsage, err := c.parseRequest(ctx, pending)
	if err != nil {
		return ChattyTurn{}, toChattyError(err)
	}
	parsed, err := ParseRequest(parsedOutput, c.Catalog.Categories)
	if err != nil {
		return ChattyTurn{}, toChattyError(err)
	}

	requestContext, err := PrepareRequestContext(parsed, userID, c.Catalog, ev)
	if err != nil {
		return ChattyTurn{}, toChattyError(err)
	}
	reply, err := c.Executor.Respond(ctx, requestContext, ev, text, chatCtx.History)
	if err != nil {
		return ChattyTurn{}, toChattyError(err)
	}

	usage := Usage{}
	usage.Add(parseUsage)
	usage.Add(ev.Usage)

	clarifying := reply.Kind == models.ReplyClarify
	next := ChattyContext{Turns: chatCtx.Turns + 1}
	if clarifying {
		next.PendingUserMessages = pending
		next.History = append(append([]ChatMessage{}, chatCtx.History...), clarificationHistory(text, reply.Question, reply.Answer)...)
	} else {
		next.PendingUserMessages = []string{}
		next.History = []ChatMessage{}
	}

	return ChattyTurn{
		Reply:        reply,
		UnderstoodAs: DescribeRequest(parsed),
		Context:      next,
		TurnsLeft:    MaxTurns - next.Turns,
		Trace:        traceSteps(ev),
		Usage:        usage,
		LatencyMs:    float64(time.Since(started).Milliseconds()),
	}, nil
}

func (c *Chatty) parseRequest(ctx context.Context, pending []string) (RequestParseOutput, Usage, error) {
	prompt, err := os.ReadFile(filepath.Join(c.Prompts, "request_parser.md"))
	if err != nil {
		return RequestParseOutput{}, Usage{}, err
	}
	cats, _ := json.Marshal(c.Catalog.Categories)
	var b strings.Builder
	for i, msg := range pending {
		fmt.Fprintf(&b, "用户第%d轮：%s\n", i+1, msg)
	}
	messages := []ChatMessage{
		{Role: "system", Content: string(prompt) + "\nAvailable categories: " + string(cats) + "\nRespond with JSON only."},
		{Role: "user", Content: b.String()},
	}
	msg, usage, err := c.Provider.Chat(ctx, messages, nil, nil)
	if err != nil {
		return RequestParseOutput{}, usage, err
	}
	out, err := ParseRequestOutput(msg.Content)
	if err != nil {
		// try wrapping recovery already in ParseRequestOutput; fail as parse
		return RequestParseOutput{}, usage, RequestParseError("request_parse_failed")
	}
	return out, usage, nil
}

func toChattyError(err error) error {
	if err == nil {
		return nil
	}
	if ce, ok := err.(*ChattyError); ok {
		return ce
	}
	if err.Error() == "llm_not_configured" {
		return &ChattyError{Code: "llm_not_configured", Cause: err}
	}
	if _, ok := err.(RequestParseError); ok {
		return &ChattyError{Code: "request_parse_failed", Cause: err}
	}
	if re, ok := err.(*RecommendationError); ok {
		return &ChattyError{Code: re.Code, Diagnostics: re.Diagnostics, Cause: err}
	}
	if ee, ok := err.(*EvidenceError); ok {
		return &ChattyError{Code: ee.Code, Diagnostics: map[string]any{"missing": ee.Missing, "detail": ee.Detail}, Cause: err}
	}
	if ce, ok := err.(catalog.Error); ok {
		return &ChattyError{Code: string(ce), Cause: err}
	}
	return &ChattyError{Code: "recommendation_failed", Diagnostics: map[string]any{"cause": err.Error()}, Cause: err}
}

func traceSteps(ev *Evidence) []string {
	seen := map[string]struct{}{}
	steps := []string{"request_parsing"}
	for _, t := range ev.UsedTools {
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		steps = append(steps, t)
	}
	steps = append(steps, "response_generation", "evidence_validation")
	return steps
}

func clarificationHistory(userText, question string, answer *string) []ChatMessage {
	payload := map[string]any{"action": "clarify", "question": question, "answer": answer}
	raw, _ := json.Marshal(payload)
	return []ChatMessage{
		{Role: "user", Content: userText},
		{Role: "assistant", Content: string(raw)},
	}
}
