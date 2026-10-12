package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/ImWenyaoT/chatty/backend/internal/agent"
	"github.com/ImWenyaoT/chatty/backend/internal/api"
	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/models"
	"github.com/ImWenyaoT/chatty/backend/internal/session"
)

func seedDir(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "data", "seed"))
}

type fakeChatty struct{}

func (f fakeChatty) Run(_ context.Context, _, text string, chatCtx agent.ChattyContext) (agent.ChattyTurn, error) {
	if chatCtx.Turns >= agent.MaxTurns {
		return agent.ChattyTurn{}, &agent.ChattyError{Code: "conversation_exhausted"}
	}
	ans := "演示回答：" + text
	return agent.ChattyTurn{
		Reply:        models.Reply{Kind: models.ReplyAnswer, Answer: &ans},
		UnderstoodAs: "知识 · " + text,
		Context:      agent.ChattyContext{Turns: chatCtx.Turns + 1},
		TurnsLeft:    agent.MaxTurns - (chatCtx.Turns + 1),
		Trace:        []string{"request_parsing", "retrieve_knowledge", "response_generation", "evidence_validation"},
		Usage:        agent.Usage{Requests: 1, InputTokens: 10, OutputTokens: 5, TotalTokens: 15},
		LatencyMs:    12,
	}, nil
}

func newTestServer(t *testing.T, chatty agent.Agent) *httptest.Server {
	t.Helper()
	cat, err := catalog.New(":memory:", seedDir(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cat.Close() })
	srv := api.New(api.Dependencies{
		Catalog:  cat,
		Chatty:   chatty,
		Sessions: session.NewStore(),
		ModelID:  "test-model",
	})
	return httptest.NewServer(srv.Handler())
}

func TestHealthAndCatalog(t *testing.T) {
	ts := newTestServer(t, fakeChatty{})
	defer ts.Close()

	res, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}

	res, err = http.Get(ts.URL + "/api/catalog")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var info map[string]any
	_ = json.NewDecoder(res.Body).Decode(&info)
	if info["product_count"].(float64) <= 0 {
		t.Fatal("expected products")
	}

	res, err = http.Get(ts.URL + "/api/catalog/data")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var data struct {
		Products []models.Product `json:"products"`
		Profiles []map[string]any `json:"profiles"`
	}
	_ = json.NewDecoder(res.Body).Decode(&data)
	if len(data.Products) == 0 || data.Products[0].ProductID != "P001" {
		t.Fatalf("unexpected products: %+v", data.Products[:1])
	}
	if len(data.Profiles) != 5 {
		t.Fatalf("profiles=%d", len(data.Profiles))
	}
}

func TestSessionAndTurn(t *testing.T) {
	ts := newTestServer(t, fakeChatty{})
	defer ts.Close()

	bad, _ := http.Post(ts.URL+"/api/sessions", "application/json", bytes.NewBufferString(`{"user_id":"missing"}`))
	defer bad.Body.Close()
	if bad.StatusCode != 422 {
		t.Fatalf("want 422 got %d", bad.StatusCode)
	}

	res, err := http.Post(ts.URL+"/api/sessions", "application/json", bytes.NewBufferString(`{"user_id":"user_active"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var sess struct {
		SessionID string `json:"session_id"`
	}
	_ = json.NewDecoder(res.Body).Decode(&sess)
	if sess.SessionID == "" {
		t.Fatal("empty session")
	}

	blank, _ := http.Post(ts.URL+"/api/sessions/"+sess.SessionID+"/turns", "application/json", bytes.NewBufferString(`{"text":"   "}`))
	defer blank.Body.Close()
	if blank.StatusCode != 422 {
		t.Fatalf("blank want 422 got %d", blank.StatusCode)
	}

	turnRes, err := http.Post(ts.URL+"/api/sessions/"+sess.SessionID+"/turns", "application/json", bytes.NewBufferString(`{"text":"七天无理由怎么退"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer turnRes.Body.Close()
	if turnRes.StatusCode != 200 {
		t.Fatalf("turn status %d", turnRes.StatusCode)
	}
	var turn map[string]any
	_ = json.NewDecoder(turnRes.Body).Decode(&turn)
	if turn["kind"] != "answer" {
		t.Fatalf("kind=%v", turn["kind"])
	}
}

func TestCatalogSearchAndKnowledge(t *testing.T) {
	cat, err := catalog.New(":memory:", seedDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defer cat.Close()
	profile, err := cat.UserProfile("user_active", models.EmptyUserContext())
	if err != nil {
		t.Fatal(err)
	}
	products, err := cat.Search(profile, []string{"耳机"}, 0, 30000, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(products) == 0 {
		t.Fatal("expected headphone candidates")
	}
	hits, err := cat.RetrieveKnowledge("七天无理由", nil, nil, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("expected knowledge hits")
	}
}
