package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/ImWenyaoT/chatty/backend/internal/agent"
	"github.com/ImWenyaoT/chatty/backend/internal/api"
	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/session"
	"github.com/ImWenyaoT/chatty/backend/internal/settings"
)

func main() {
	repoRoot := findRepoRoot()
	cfg := settings.Load(repoRoot)
	promptsDir := filepath.Join(repoRoot, "backend", "prompts")

	cat, err := catalog.New(":memory:", cfg.SeedDir)
	if err != nil {
		log.Fatalf("catalog: %v", err)
	}
	defer cat.Close()

	provider := agent.NewProvider(cfg.APIKey, cfg.BaseURL, cfg.Model)
	chatty := agent.NewChatty(cat, provider, promptsDir)
	srv := api.New(api.Dependencies{
		Catalog:  cat,
		Chatty:   chatty,
		Sessions: session.NewStore(),
		ModelID:  cfg.Model,
	})

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("chatty api listening on http://127.0.0.1%s (model=%s configured=%v)", addr, cfg.Model, provider.Configured())
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		log.Fatal(err)
	}
}

func findRepoRoot() string {
	if v := os.Getenv("CHATTY_ROOT"); v != "" {
		return v
	}
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	dir := wd
	for {
		if _, err := os.Stat(filepath.Join(dir, "data", "seed")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return wd
		}
		dir = parent
	}
}
