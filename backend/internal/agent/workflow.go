package agent

import (
	"fmt"
	"sort"
	"strings"
)

const MaxKnowledgeCallsPerScope = 3

type WorkflowStage string

const (
	StageNeedSupport  WorkflowStage = "NEED_SUPPORT"
	StageReadyToDraft WorkflowStage = "READY_TO_DRAFT"
)

func knowledgeCallCount(ev *Evidence, scope KnowledgeScope) int {
	return ev.AttemptedKnowledgeScopes[scope]
}

func knowledgeScopeSettled(ev *Evidence, scope KnowledgeScope) bool {
	if _, ok := ev.CompletedKnowledgeScopes[scope]; ok {
		return true
	}
	return knowledgeCallCount(ev, scope) >= MaxKnowledgeCallsPerScope
}

func StageFor(ev *Evidence) WorkflowStage {
	used := map[string]struct{}{}
	for _, t := range ev.UsedTools {
		used[t] = struct{}{}
	}
	for _, tool := range ev.RequiredSupportTools {
		if _, ok := used[tool]; !ok {
			return StageNeedSupport
		}
	}
	for _, scope := range ev.RequiredKnowledgeScopes {
		if !knowledgeScopeSettled(ev, scope) {
			return StageNeedSupport
		}
	}
	return StageReadyToDraft
}

func AllowedTools(ev *Evidence) []string {
	used := map[string]struct{}{}
	for _, t := range ev.UsedTools {
		used[t] = struct{}{}
	}
	seen := map[string]struct{}{}
	var allowed []string
	add := func(name string) {
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		allowed = append(allowed, name)
	}
	for _, scope := range ev.RequiredKnowledgeScopes {
		if !knowledgeScopeSettled(ev, scope) {
			add("retrieve_knowledge")
			break
		}
	}
	for _, tool := range ev.RequiredSupportTools {
		if tool == "retrieve_knowledge" {
			// 知识工具只由 scope 结算驱动，避免与 RequiredSupportTools 重复列出。
			continue
		}
		if _, ok := used[tool]; !ok {
			add(tool)
		}
	}
	return allowed
}

func RenderAgentStatus(ev *Evidence) string {
	stage := StageFor(ev)
	completedSet := map[string]struct{}{}
	for _, t := range ev.UsedTools {
		completedSet[t] = struct{}{}
	}
	var completed []string
	for t := range completedSet {
		completed = append(completed, t)
	}
	sort.Strings(completed)
	completedStr := "none"
	if len(completed) > 0 {
		completedStr = strings.Join(completed, ", ")
	}
	reqScopes := "none"
	if len(ev.RequiredKnowledgeScopes) > 0 {
		parts := make([]string, len(ev.RequiredKnowledgeScopes))
		for i, s := range ev.RequiredKnowledgeScopes {
			parts[i] = string(s)
		}
		reqScopes = strings.Join(parts, ", ")
	}
	var doneScopes []string
	for s := range ev.CompletedKnowledgeScopes {
		doneScopes = append(doneScopes, string(s))
	}
	sort.Strings(doneScopes)
	doneStr := "none"
	if len(doneScopes) > 0 {
		doneStr = strings.Join(doneScopes, ", ")
	}
	var callParts []string
	for _, scope := range ev.RequiredKnowledgeScopes {
		callParts = append(callParts, fmt.Sprintf("%s %d/%d", scope, knowledgeCallCount(ev, scope), MaxKnowledgeCallsPerScope))
	}
	callsStr := "none"
	if len(callParts) > 0 {
		callsStr = strings.Join(callParts, ", ")
	}
	next := AllowedTools(ev)
	if stage == StageReadyToDraft {
		next = append(next, "final_output")
	}
	allowedFinal := strings.Join(ev.AllowedFinalActions, ", ")
	if allowedFinal == "" {
		allowedFinal = "none"
	}
	version := len(ev.UsedTools) + len(ev.BlockedAttempts)
	return strings.Join([]string{
		fmt.Sprintf(`<agent_status version="%d">`, version),
		"stage: " + string(stage),
		"completed_steps: " + completedStr,
		"required_knowledge_scopes: " + reqScopes,
		"completed_knowledge_scopes: " + doneStr,
		"knowledge_calls: " + callsStr,
		"allowed_next: " + strings.Join(next, ", "),
		"allowed_final_action: " + allowedFinal,
		"final_action_check: " + finalActionCheck(ev),
		fmt.Sprintf("blocked_attempts: %d", len(ev.BlockedAttempts)),
		"</agent_status>",
	}, "\n")
}

func finalActionCheck(ev *Evidence) string {
	if len(ev.AllowedFinalActions) == 0 {
		return "task context not prepared"
	}
	hasAnswer := false
	for _, a := range ev.AllowedFinalActions {
		if a == "answer" {
			hasAnswer = true
			break
		}
	}
	if !hasAnswer {
		return fmt.Sprintf("'answer' is NOT allowed this turn (product request present) — use %s", strings.Join(ev.AllowedFinalActions, " or "))
	}
	return "only 'answer' is allowed this turn (no product request)"
}

type GateDecision struct {
	Allowed bool
	Reason  string
}

type ToolBatch struct {
	Stage    WorkflowStage
	Allowed  map[string]struct{}
	Accepted map[string]struct{}
}

func OpenToolBatch(ev *Evidence) *ToolBatch {
	allowed := map[string]struct{}{}
	for _, t := range AllowedTools(ev) {
		allowed[t] = struct{}{}
	}
	return &ToolBatch{
		Stage:    StageFor(ev),
		Allowed:  allowed,
		Accepted: map[string]struct{}{},
	}
}

func GateToolCall(batch *ToolBatch, toolName string) GateDecision {
	if _, ok := batch.Allowed[toolName]; !ok {
		return GateDecision{Allowed: false, Reason: "tool_not_allowed_in_stage"}
	}
	if _, ok := batch.Accepted[toolName]; ok {
		return GateDecision{Allowed: false, Reason: "duplicate_tool_in_batch"}
	}
	batch.Accepted[toolName] = struct{}{}
	return GateDecision{Allowed: true}
}
