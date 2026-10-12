package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/ImWenyaoT/chatty/backend/internal/agent"
	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/models"
	"github.com/ImWenyaoT/chatty/backend/internal/session"
)

type Dependencies struct {
	Catalog  *catalog.Catalog
	Chatty   agent.Agent
	Sessions *session.Store
	ModelID  string
}

type Server struct {
	deps Dependencies
	mux  *http.ServeMux
}

func New(deps Dependencies) *Server {
	if deps.Sessions == nil {
		deps.Sessions = session.NewStore()
	}
	s := &Server{deps: deps, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler {
	return withCORS(s.mux)
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /health", s.health)
	s.mux.HandleFunc("GET /api/catalog", s.catalogInfo)
	s.mux.HandleFunc("GET /api/catalog/data", s.catalogData)
	s.mux.HandleFunc("POST /api/sessions", s.createSession)
	s.mux.HandleFunc("POST /api/sessions/{sessionId}/turns", s.takeTurn)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) catalogInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"categories":    s.deps.Catalog.Categories,
		"users":         models.DemoUsers,
		"product_count": len(s.deps.Catalog.Products),
		"model_id":      s.deps.ModelID,
	})
}

func (s *Server) catalogData(w http.ResponseWriter, _ *http.Request) {
	profiles := make([]map[string]any, 0, len(models.DemoUsers))
	for _, u := range models.DemoUsers {
		p, err := s.deps.Catalog.UserProfile(u.ID, models.EmptyUserContext())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "catalog_error")
			return
		}
		profiles = append(profiles, map[string]any{
			"user_id":               p.UserID,
			"segment":               p.Segment,
			"preferred_categories":  p.PreferredCategories,
			"min_price_cents":       p.MinPriceCents,
			"max_price_cents":       p.MaxPriceCents,
			"recent_views":          p.RecentViews,
			"recent_purchases":      p.RecentPurchases,
			"display_name":          u.DisplayName,
			"profile_label":         u.ProfileLabel,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"products": s.deps.Catalog.Products,
		"profiles": profiles,
	})
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "invalid_request")
		return
	}
	if body.UserID == "" {
		body.UserID = "user_active"
	}
	if _, ok := models.DemoUserIDs()[body.UserID]; !ok {
		writeErr(w, http.StatusUnprocessableEntity, "unknown_user")
		return
	}
	id := s.deps.Sessions.Create(body.UserID)
	writeJSON(w, http.StatusOK, map[string]string{"session_id": id})
}

func (s *Server) takeTurn(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")
	sess, ok := s.deps.Sessions.Get(sessionID)
	if !ok {
		writeErr(w, http.StatusNotFound, "session_not_found")
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "invalid_request")
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" || len([]rune(text)) > 500 {
		writeErr(w, http.StatusUnprocessableEntity, "invalid_request")
		return
	}

	var (
		turn agent.ChattyTurn
		runErr error
	)
	_ = sess.RunExclusive(func(sess *session.Session) error {
		t, err := s.deps.Chatty.Run(r.Context(), sess.UserID, text, sess.Context)
		if err != nil {
			runErr = err
			return nil
		}
		sess.Context = t.Context
		turn = t
		return nil
	})
	if runErr != nil {
		var ce *agent.ChattyError
		if errors.As(runErr, &ce) {
			status := http.StatusUnprocessableEntity
			if ce.Code == "conversation_exhausted" {
				status = http.StatusConflict
			}
			writeErr(w, status, ce.Code)
			return
		}
		writeErr(w, http.StatusUnprocessableEntity, "recommendation_failed")
		return
	}

	common := map[string]any{
		"understood_as": turn.UnderstoodAs,
		"answer":        turn.Reply.Answer,
		"latency_ms":    turn.LatencyMs,
		"turns_left":    turn.TurnsLeft,
		"trace":         turn.Trace,
		"usage": map[string]any{
			"model_requests": turn.Usage.Requests,
			"input_tokens":   turn.Usage.InputTokens,
			"output_tokens":  turn.Usage.OutputTokens,
			"total_tokens":   turn.Usage.TotalTokens,
		},
		"question": nil,
		"products": []any{},
	}
	switch turn.Reply.Kind {
	case models.ReplyAnswer:
		common["kind"] = "answer"
	case models.ReplyClarify:
		kind := "clarify"
		if turn.TurnsLeft == 0 {
			kind = "exhausted"
		}
		common["kind"] = kind
		common["question"] = turn.Reply.Question
	default:
		common["kind"] = "recommend"
		common["products"] = turn.Reply.Products
	}
	writeJSON(w, http.StatusOK, common)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]string{"detail": detail})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
