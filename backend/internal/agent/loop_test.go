package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

type scriptedModel struct {
	responses []ChatMessage
	i         int
}

func (s *scriptedModel) Configured() bool { return true }

func (s *scriptedModel) Chat(_ context.Context, _ []ChatMessage, _ []ToolDef, _ any) (ChatMessage, Usage, error) {
	if s.i >= len(s.responses) {
		return ChatMessage{}, Usage{}, &RecommendationError{Code: "script_exhausted"}
	}
	msg := s.responses[s.i]
	s.i++
	return msg, Usage{Requests: 1, InputTokens: 1, OutputTokens: 1, TotalTokens: 2}, nil
}

func promptsDir(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "prompts"))
}

func seedDir(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "data", "seed"))
}

func TestLoopBlockedToolReturnsResultNotCrash(t *testing.T) {
	cat, err := catalog.New(":memory:", seedDir(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cat.Close() })

	ans := "七天无理由退货说明"
	model := &scriptedModel{responses: []ChatMessage{
		{
			Role: "assistant",
			ToolCalls: []ToolCall{{
				ID:       "1",
				Type:     "function",
				Function: ToolFunction{Name: "get_marketing_strategy", Arguments: "{}"},
			}},
		},
		{
			Role: "assistant",
			ToolCalls: []ToolCall{{
				ID:   "2",
				Type: "function",
				Function: ToolFunction{
					Name:      "retrieve_knowledge",
					Arguments: `{"query":"退货","limit":3,"scope":"general"}`,
				},
			}},
		},
		{
			Role:    "assistant",
			Content: mustJSON(t, map[string]any{"action": "answer", "answer": ans}),
		},
	}}

	exec := NewExecutor(cat, model, promptsDir(t))
	ev := NewEvidence()
	ev.RequiredSupportTools = []string{"retrieve_knowledge"}
	ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeGeneral}
	ev.AllowedFinalActions = []string{"answer"}
	kq := "退货"
	rc := models.RequestContext{Request: models.ParsedRequest{KnowledgeQuery: &kq}}
	sink := &TraceSink{}

	draft, err := exec.runLoop(context.Background(), rc, ev, "怎么退货", nil, sink)
	if err != nil {
		t.Fatal(err)
	}
	if draft.Action != models.ActionAnswer || draft.Answer == nil || *draft.Answer != ans {
		t.Fatalf("draft=%+v", draft)
	}
	if len(ev.BlockedAttempts) == 0 {
		t.Fatal("expected blocked attempt for marketing in knowledge-only turn")
	}
	blocked := false
	for _, e := range sink.Events() {
		if e.Kind == "tool_blocked" && e.Tool == "get_marketing_strategy" {
			blocked = true
		}
	}
	if !blocked {
		t.Fatalf("trace events=%+v", sink.Events())
	}
}

func TestLoopReadyToDraftWithoutTools(t *testing.T) {
	cat, err := catalog.New(":memory:", seedDir(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cat.Close() })

	ans := "已检索后的回答"
	model := &scriptedModel{responses: []ChatMessage{
		{Role: "assistant", Content: mustJSON(t, map[string]any{"action": "answer", "answer": ans})},
	}}
	exec := NewExecutor(cat, model, promptsDir(t))
	ev := NewEvidence()
	ev.RequiredSupportTools = []string{"retrieve_knowledge"}
	ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeGeneral}
	ev.AllowedFinalActions = []string{"answer"}
	ev.UsedTools = []string{"retrieve_knowledge"}
	ev.CompletedKnowledgeScopes[ScopeGeneral] = struct{}{}
	ev.GeneralKnowledgeHits = 1
	ev.Knowledge = []models.KnowledgeHit{{DocID: "d", Title: "t", Content: "c"}}
	kq := "政策"
	rc := models.RequestContext{Request: models.ParsedRequest{KnowledgeQuery: &kq}}

	draft, err := exec.runLoop(context.Background(), rc, ev, "政策", nil, &TraceSink{})
	if err != nil {
		t.Fatal(err)
	}
	if draft.Action != models.ActionAnswer {
		t.Fatalf("action=%s", draft.Action)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
