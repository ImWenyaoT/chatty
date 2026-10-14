package agent

import (
	"testing"
)

func TestModelToolsExcludeSubagents(t *testing.T) {
	forbidden := map[string]struct{}{
		"request_parser":  {},
		"draft_corrector": {},
		"handoff":         {},
		"transfer_to":     {},
		"AgentTool":       {},
	}
	for _, def := range ToolDefinitions() {
		name := def.Function.Name
		if _, bad := forbidden[name]; bad {
			t.Fatalf("model tools must not expose subagent/handoff name %q", name)
		}
		for _, sub := range []string{"request_parser", "draft_corrector"} {
			if name == sub {
				t.Fatalf("subagent %q leaked into tools[]", sub)
			}
		}
	}
	names := ModelToolNames()
	if len(names) == 0 {
		t.Fatal("expected at least one model tool")
	}
	for _, n := range names {
		if _, bad := forbidden[n]; bad {
			t.Fatalf("forbidden tool name registered: %q", n)
		}
	}
}

func TestNoHandoffSurface(t *testing.T) {
	// Single Agent：不得出现 handoff 契约或注册表。
	for _, def := range ToolDefinitions() {
		if def.Type == "handoff" {
			t.Fatal("handoff tool type must not exist")
		}
	}
	if HasHandoffs() {
		t.Fatal("HasHandoffs must be false")
	}
}
