package agent

import "testing"

func TestModelToolsExcludeSubagentsAndHandoffs(t *testing.T) {
	forbidden := map[string]struct{}{
		"request_parser":  {},
		"draft_corrector": {},
		"handoff":         {},
		"transfer_to":     {},
		"AgentTool":       {},
	}
	defs := ToolDefinitions()
	if len(defs) == 0 {
		t.Fatal("expected at least one model tool")
	}
	for _, def := range defs {
		if def.Type == "handoff" {
			t.Fatal("handoff tool type must not exist")
		}
		name := def.Function.Name
		if _, bad := forbidden[name]; bad {
			t.Fatalf("model tools must not expose %q", name)
		}
	}
}
