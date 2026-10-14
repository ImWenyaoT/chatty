package agent

import (
	"context"

	"github.com/ImWenyaoT/chatty/backend/internal/catalog"
	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

type RecommendationError struct {
	Code        string
	Diagnostics map[string]any
}

func (e *RecommendationError) Error() string { return e.Code }

// ModelClient 是 Loop 对 Model 的窄接口；*Provider 实现之。
type ModelClient interface {
	Chat(ctx context.Context, messages []ChatMessage, tools []ToolDef, toolChoice any) (ChatMessage, Usage, error)
	Configured() bool
}

// Executor 持有 Loop + ToolRuntime 依赖；对外仍由 Orchestrator（Chatty）调用。
type Executor struct {
	Catalog  *catalog.Catalog
	Model    ModelClient
	Prompts  string
	Budget   ContextBudget
}

func NewExecutor(cat *catalog.Catalog, model ModelClient, promptsDir string) *Executor {
	return &Executor{
		Catalog: cat,
		Model:   model,
		Prompts: promptsDir,
		Budget:  DefaultContextBudget(),
	}
}

func (e *Executor) Respond(ctx context.Context, requestContext models.RequestContext, ev *Evidence, userText string, history []ChatMessage, sink *TraceSink) (models.Reply, error) {
	draft, err := e.runLoop(ctx, requestContext, ev, userText, history, sink)
	if err != nil {
		return models.Reply{}, err
	}
	return e.finalizeReply(requestContext, ev, draft)
}
