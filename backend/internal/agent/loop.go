package agent

import (
	"context"
	"strings"

	"github.com/ImWenyaoT/chatty/backend/internal/models"
)

const maxLoopIterations = 12

// runLoop 是唯一的 Agent Loop：iteration → Model → Gate+Execute → draft。
// Subagent corrector 仅在无 tool_use 且 draft 非法时由 Harness 触发。
func (e *Executor) runLoop(ctx context.Context, requestContext models.RequestContext, ev *Evidence, userText string, history []ChatMessage, sink *TraceSink) (models.AgentDraft, error) {
	instructions, err := LoadStaticInstructions(e.Prompts)
	if err != nil {
		return models.AgentDraft{}, err
	}
	harnessXML := RenderHarnessContextXML(requestContext, e.Budget)
	messages := buildInitialLoopMessages(instructions, userText, history, harnessXML)
	tools := ToolDefinitions()
	toolChoice := any("required")

	for iteration := 0; iteration < maxLoopIterations; iteration++ {
		status := RenderAgentStatus(ev)
		roundMsgs := append(append([]ChatMessage{}, messages...), ChatMessage{Role: "system", Content: status})
		if StageFor(ev) == StageReadyToDraft {
			toolChoice = "auto"
		}
		sink.Add(TraceEvent{Kind: "iteration", Iteration: iteration + 1, Stage: string(StageFor(ev))})
		msg, usage, err := e.Model.Chat(ctx, roundMsgs, tools, toolChoice)
		if err != nil {
			return models.AgentDraft{}, err
		}
		ev.Usage.Add(usage)
		if len(msg.ToolCalls) == 0 {
			draft, err := parseAgentDraft(msg.Content, ev.AllowedFinalActions)
			if err != nil {
				corrected, corrUsage, cerr := e.correctDraft(ctx, msg.Content, ev.AllowedFinalActions)
				ev.Usage.Add(corrUsage)
				if cerr != nil {
					return models.AgentDraft{}, &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "correction_failed", "cause": cerr.Error()}}
				}
				sink.Add(TraceEvent{Kind: "draft_corrected"})
				return corrected, nil
			}
			sink.Add(TraceEvent{Kind: "draft_ready", Detail: string(draft.Action)})
			return draft, nil
		}
		messages = append(messages, msg)
		batch := OpenToolBatch(ev)
		for _, call := range msg.ToolCalls {
			decision := GateToolCall(batch, call.Function.Name)
			if !decision.Allowed {
				ev.BlockedAttempts = append(ev.BlockedAttempts, strings.Join([]string{string(batch.Stage), call.Function.Name, decision.Reason}, ":"))
				sink.Add(TraceEvent{Kind: "tool_blocked", Tool: call.Function.Name, Stage: string(batch.Stage), Detail: decision.Reason, Iteration: iteration + 1})
				messages = append(messages, ChatMessage{
					Role:       "tool",
					ToolCallID: call.ID,
					Name:       call.Function.Name,
					Content:    formatBlockedToolResult(batch, ev, decision.Reason),
				})
				continue
			}
			result, err := e.executeTool(call, requestContext, ev)
			if err != nil {
				result = formatToolError(err)
				sink.Add(TraceEvent{Kind: "tool_error", Tool: call.Function.Name, Detail: err.Error(), Iteration: iteration + 1})
			} else {
				sink.Add(TraceEvent{Kind: "tool_result", Tool: call.Function.Name, Iteration: iteration + 1})
			}
			messages = append(messages, ChatMessage{
				Role:       "tool",
				ToolCallID: call.ID,
				Name:       call.Function.Name,
				Content:    result,
			})
		}
		toolChoice = "auto"
	}
	return models.AgentDraft{}, &RecommendationError{Code: "invalid_draft", Diagnostics: map[string]any{"reason": "max_turns_exceeded"}}
}

func (e *Executor) correctDraft(ctx context.Context, raw string, allowed []string) (models.AgentDraft, Usage, error) {
	prompt, err := readPromptFile(e.Prompts, "draft_corrector.md")
	if err != nil {
		return models.AgentDraft{}, Usage{}, err
	}
	messages := []ChatMessage{
		{Role: "system", Content: prompt + "\nAllowed actions: " + strings.Join(allowed, ", ") + "\nRespond with JSON only."},
		{Role: "user", Content: raw},
	}
	msg, usage, err := e.Model.Chat(ctx, messages, nil, nil)
	if err != nil {
		return models.AgentDraft{}, usage, err
	}
	draft, err := parseAgentDraft(msg.Content, allowed)
	return draft, usage, err
}
