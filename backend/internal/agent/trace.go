package agent

import "fmt"

// TraceEvent 为轮内可观测事件；HTTP 仍投影为 []string Trace 以兼容前端。
type TraceEvent struct {
	Kind    string `json:"kind"`
	Detail  string `json:"detail,omitempty"`
	Tool    string `json:"tool,omitempty"`
	Stage   string `json:"stage,omitempty"`
	Iteration int  `json:"iteration,omitempty"`
}

type TraceSink struct {
	events []TraceEvent
}

func (t *TraceSink) Add(ev TraceEvent) {
	if t == nil {
		return
	}
	t.events = append(t.events, ev)
}

func (t *TraceSink) Events() []TraceEvent {
	if t == nil {
		return nil
	}
	return append([]TraceEvent{}, t.events...)
}

// Steps 投影为现有 API 的 string[]，保留 request_parsing 等稳定步骤名。
func (t *TraceSink) Steps(ev *Evidence) []string {
	seen := map[string]struct{}{}
	steps := []string{"request_parsing"}
	if ev != nil {
		for _, tool := range ev.UsedTools {
			if _, ok := seen[tool]; ok {
				continue
			}
			seen[tool] = struct{}{}
			steps = append(steps, tool)
		}
	}
	if t != nil {
		for _, e := range t.events {
			if e.Kind == "tool_blocked" {
				label := fmt.Sprintf("blocked:%s", e.Tool)
				if _, ok := seen[label]; ok {
					continue
				}
				seen[label] = struct{}{}
				steps = append(steps, label)
			}
		}
	}
	steps = append(steps, "response_generation", "evidence_validation")
	return steps
}
