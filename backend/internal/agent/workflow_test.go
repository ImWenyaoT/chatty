package agent

import (
	"testing"
)

func TestStageForNeedSupportUntilKnowledgeSettled(t *testing.T) {
	ev := NewEvidence()
	ev.RequiredSupportTools = []string{"retrieve_knowledge", "get_marketing_strategy"}
	ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeProduct}
	if StageFor(ev) != StageNeedSupport {
		t.Fatalf("stage=%s", StageFor(ev))
	}

	ev.UsedTools = append(ev.UsedTools, "retrieve_knowledge")
	ev.CompletedKnowledgeScopes[ScopeProduct] = struct{}{}
	if StageFor(ev) != StageNeedSupport {
		t.Fatalf("still need marketing, stage=%s", StageFor(ev))
	}

	ev.UsedTools = append(ev.UsedTools, "get_marketing_strategy")
	if StageFor(ev) != StageReadyToDraft {
		t.Fatalf("want READY_TO_DRAFT got %s", StageFor(ev))
	}
}

func TestStageForKnowledgeExhaustionSettlesScope(t *testing.T) {
	ev := NewEvidence()
	ev.RequiredSupportTools = []string{"retrieve_knowledge"}
	ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeGeneral}
	ev.AllowedFinalActions = []string{"answer"}
	for i := 0; i < MaxKnowledgeCallsPerScope; i++ {
		ev.AttemptedKnowledgeScopes[ScopeGeneral]++
		ev.UsedTools = append(ev.UsedTools, "retrieve_knowledge")
	}
	if StageFor(ev) != StageReadyToDraft {
		t.Fatalf("exhausted scope should settle, stage=%s", StageFor(ev))
	}
}

func TestGateToolCallTable(t *testing.T) {
	cases := []struct {
		name       string
		setup      func() *ToolBatch
		tool       string
		wantAllow  bool
		wantReason string
		secondTool string // if set, call twice
	}{
		{
			name: "allowed_in_need_support",
			setup: func() *ToolBatch {
				ev := NewEvidence()
				ev.RequiredSupportTools = []string{"retrieve_knowledge", "get_marketing_strategy"}
				ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeGeneral}
				return OpenToolBatch(ev)
			},
			tool:      "retrieve_knowledge",
			wantAllow: true,
		},
		{
			name: "blocked_when_not_in_stage",
			setup: func() *ToolBatch {
				ev := NewEvidence()
				ev.RequiredSupportTools = []string{"retrieve_knowledge", "get_marketing_strategy"}
				ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeGeneral}
				ev.UsedTools = []string{"retrieve_knowledge", "get_marketing_strategy"}
				ev.CompletedKnowledgeScopes[ScopeGeneral] = struct{}{}
				return OpenToolBatch(ev)
			},
			tool:       "retrieve_knowledge",
			wantAllow:  false,
			wantReason: "tool_not_allowed_in_stage",
		},
		{
			name: "duplicate_in_batch",
			setup: func() *ToolBatch {
				ev := NewEvidence()
				ev.RequiredSupportTools = []string{"retrieve_knowledge", "get_marketing_strategy"}
				ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeGeneral}
				return OpenToolBatch(ev)
			},
			tool:       "retrieve_knowledge",
			wantAllow:  false,
			wantReason: "duplicate_tool_in_batch",
			secondTool: "retrieve_knowledge",
		},
		{
			name: "unknown_tool",
			setup: func() *ToolBatch {
				ev := NewEvidence()
				ev.RequiredSupportTools = []string{"retrieve_knowledge"}
				ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeGeneral}
				return OpenToolBatch(ev)
			},
			tool:       "request_parser",
			wantAllow:  false,
			wantReason: "tool_not_allowed_in_stage",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			batch := tc.setup()
			tool := tc.tool
			if tc.secondTool != "" {
				first := GateToolCall(batch, tc.secondTool)
				if !first.Allowed {
					t.Fatalf("first call should allow: %+v", first)
				}
			}
			got := GateToolCall(batch, tool)
			if got.Allowed != tc.wantAllow {
				t.Fatalf("allowed=%v want %v reason=%s", got.Allowed, tc.wantAllow, got.Reason)
			}
			if !tc.wantAllow && got.Reason != tc.wantReason {
				t.Fatalf("reason=%q want %q", got.Reason, tc.wantReason)
			}
		})
	}
}

func TestAllowedToolsReadyToDraftEmpty(t *testing.T) {
	ev := NewEvidence()
	ev.RequiredSupportTools = []string{"retrieve_knowledge", "get_marketing_strategy"}
	ev.RequiredKnowledgeScopes = []KnowledgeScope{ScopeProduct}
	ev.UsedTools = []string{"retrieve_knowledge", "get_marketing_strategy"}
	ev.CompletedKnowledgeScopes[ScopeProduct] = struct{}{}
	if got := AllowedTools(ev); len(got) != 0 {
		t.Fatalf("allowed=%v", got)
	}
}
