package agent

import "strconv"

// ToolContract 是主 Agent 可见 Tool 的轻量合同（非 Agent）。
// Harness Subagent（request_parser / draft_corrector）不得出现在此注册表。
type ToolContract struct {
	Name            string
	Description     string
	Parameters      map[string]any
	ConcurrencySafe bool
	MaxResultChars  int
}

const defaultToolResultChars = 4000

var modelToolRegistry = []ToolContract{
	{
		Name:            "retrieve_knowledge",
		Description:     "检索政策或商品知识。知识问题使用 general；商品推荐使用 product。0 命中时改写 query 后重试，不要原样重复。",
		ConcurrencySafe: true,
		MaxResultChars:  defaultToolResultChars,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "关键词查询。"},
				"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 8},
				"scope": map[string]any{"type": "string", "enum": []string{"general", "product"}},
			},
			"required": []string{"query", "limit", "scope"},
		},
	},
	{
		Name:            "get_marketing_strategy",
		Description:     "获取画像分群对应的营销语气、写作要求与禁用词。",
		ConcurrencySafe: true,
		MaxResultChars:  2000,
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	},
}

// ModelToolNames 返回主 Agent tools[] 中的工具名（不含 Subagent）。
func ModelToolNames() []string {
	names := make([]string, len(modelToolRegistry))
	for i, t := range modelToolRegistry {
		names[i] = t.Name
	}
	return names
}

// LookupTool 按名查找合同；未知则 ok=false。
func LookupTool(name string) (ToolContract, bool) {
	for _, t := range modelToolRegistry {
		if t.Name == name {
			return t, true
		}
	}
	return ToolContract{}, false
}

// ToolDefinitions 转为 Provider Chat Completions 的 tools 载荷。
func ToolDefinitions() []ToolDef {
	out := make([]ToolDef, len(modelToolRegistry))
	for i, t := range modelToolRegistry {
		out[i] = ToolDef{
			Type: "function",
			Function: ToolDefFunc{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.Parameters,
			},
		}
	}
	return out
}

// HasHandoffs 恒为 false：Chatty 禁止 Multi-Agent / Handoff。
func HasHandoffs() bool { return false }

// ProjectToolResult 按合同裁剪进 Model 的 Tool Result 字符串。
func ProjectToolResult(name, raw string) string {
	contract, ok := LookupTool(name)
	max := defaultToolResultChars
	if ok && contract.MaxResultChars > 0 {
		max = contract.MaxResultChars
	}
	if len(raw) <= max {
		return raw
	}
	cut := raw[:max]
	return cut + `…{"truncated":true,"max_chars":` + strconv.Itoa(max) + `}`
}
