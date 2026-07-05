export type ArchitectureReference = 'openclaw' | 'codex' | 'claude-code'

export type AgentArchitectureTopic =
  | 'task scheduling 拆分'
  | '如何实现 multi agent'
  | 'loop 和流程控制'
  | '如何更好控制整个 loop 和 workflow'
  | '如何做可视化、可观测性与 terminal UI'
  | 'input 拼接 prompt'
  | '如何实现 long-term memory'
  | '如何实现 skills 和 plugins'
  | '如何做好 context auto compression'
  | 'output parser'
  | '执行器 executor'
  | '如何设计可以自由配置的 mcp'
  | '如何做好 eval 和自动化测试'
  | 'terminal 执行'
  | '如何控制 sandbox 环境'
  | '如何管理 background tasks'
  | 'terminal 读 output'
  | '基本 file I/O（读、写、搜）'

export type AgentArchitectureReferenceChoice = {
  readonly topic: AgentArchitectureTopic
  readonly primaryReference: ArchitectureReference
  readonly rationale: string
}

export type JdCapabilityTopic =
  | 'LLM API 与 KV Cache'
  | 'Agent Loop 与 Tool Use'
  | 'Reasoning 与 Planning'
  | 'Skills 与 MCP'
  | 'Memory'
  | 'Subagent 与 Multi-Agent'
  | 'Prompt / Context / Harness Engineering'
  | '评测基准与数据标注'
  | '真实任务反馈与产品指标'
  | 'UI/UX 与 demo 原型'

export type JdCapabilityReferenceChoice = {
  readonly topic: JdCapabilityTopic
  readonly primaryReference: ArchitectureReference
  readonly rationale: string
}

export type DeepSeekHarnessFeature =
  | 'chat_completions'
  | 'tool_calls'
  | 'json_object_output'
  | 'thinking_and_reasoning_effort'
  | 'context_cache_usage'
  | 'agents_sdk_custom_model'
  | 'agents_sdk_function_tools'
  | 'agents_sdk_sessions'
  | 'agents_sdk_human_in_the_loop'
  | 'openai_responses_api'
  | 'openai_hosted_tools'
  | 'openai_conversations_api'

export type DeepSeekHarnessFeatureStatus = 'supported' | 'adoptable_via_probe' | 'not_assumed'

export type DeepSeekHarnessCompatibility = {
  readonly feature: DeepSeekHarnessFeature
  readonly status: DeepSeekHarnessFeatureStatus
  readonly decision: string
}

export const ARCHITECTURE_COMPLEXITY_POLICY = {
  target: 'stay-inside-bounds',
  lowerBoundAction: 'raise-to-jd-and-prd',
  upperBoundAction: 'delete-before-optimizing',
  rule: '低于新版 jd.md 的能力要补到下限；超出 OpenClaw/Codex/Claude Code 区间且不能服务客服 harness 的实现先删除，不做优化。',
} as const

export const AGENT_COMPLEXITY_BOUNDS = {
  lowerBound: ['docs/jd.md'],
  upperBound: [
    '/Users/edward/Documents/oss/openclaw',
    '/Users/edward/Documents/oss/codex',
    '/Users/edward/Documents/oss/claude-code',
  ],
} as const

export const AGENT_ARCHITECTURE_REFERENCE_CHOICES: readonly AgentArchitectureReferenceChoice[] = [
  {
    topic: 'task scheduling 拆分',
    primaryReference: 'codex',
    rationale: '以 Codex 的 task -> tool-loop 边界作为主参考，Chatty 收敛为客服单轮窄任务。',
  },
  {
    topic: '如何实现 multi agent',
    primaryReference: 'codex',
    rationale: 'Codex 的主 agent 管理 subagent 是最接近 task scheduling 拆分的参考实现。',
  },
  {
    topic: 'loop 和流程控制',
    primaryReference: 'codex',
    rationale:
      '以 Codex 的 bounded tool-call loop、cancel、steering 和 traceable turn 作为主参考。',
  },
  {
    topic: '如何更好控制整个 loop 和 workflow',
    primaryReference: 'codex',
    rationale: 'Codex 对 loop 边界、中断、转向、收尾和审批的控制面最完整。',
  },
  {
    topic: '如何做可视化、可观测性与 terminal UI',
    primaryReference: 'codex',
    rationale: 'Codex 的 typed event stream 和 TUI 渲染是可观测性的主参考。',
  },
  {
    topic: 'input 拼接 prompt',
    primaryReference: 'codex',
    rationale:
      '以 Codex 的 history projection、tools schema 和 prefix-cache 友好上下文作为主参考。',
  },
  {
    topic: '如何实现 long-term memory',
    primaryReference: 'openclaw',
    rationale: 'OpenClaw 的 memory_search、embedding/FTS hybrid recall 是长期记忆主参考。',
  },
  {
    topic: '如何实现 skills 和 plugins',
    primaryReference: 'claude-code',
    rationale: 'Claude Code 的 agent definition、tools、MCP、hooks、skills、memory 配置是主参考。',
  },
  {
    topic: '如何做好 context auto compression',
    primaryReference: 'codex',
    rationale: 'Codex 的 auto-compact/checkpoint 摘要是主参考，Chatty 当前只保留滑窗。',
  },
  {
    topic: 'output parser',
    primaryReference: 'codex',
    rationale: 'Codex 的原生 tool call 和参数反序列化错误回喂是主参考。',
  },
  {
    topic: '执行器 executor',
    primaryReference: 'codex',
    rationale: 'Codex 的审批、sandbox、执行、结果回填 orchestrator 是主参考。',
  },
  {
    topic: '如何设计可以自由配置的 mcp',
    primaryReference: 'claude-code',
    rationale: 'Claude Code 的 MCP/tool catalog/permission mode 更接近可配置工具面。',
  },
  {
    topic: '如何做好 eval 和自动化测试',
    primaryReference: 'codex',
    rationale: 'Codex 的质量门禁、可观测 run、回归验证意识是测试体系主参考。',
  },
  {
    topic: 'terminal 执行',
    primaryReference: 'codex',
    rationale: 'Codex 的 shell approval、sandbox 和长命令执行是 terminal 执行主参考。',
  },
  {
    topic: '如何控制 sandbox 环境',
    primaryReference: 'codex',
    rationale: 'Codex 的 sandbox/approval 分层是主参考；Chatty 映射成业务 side-effect sandbox。',
  },
  {
    topic: '如何管理 background tasks',
    primaryReference: 'codex',
    rationale: 'Codex 的后台 turn、cancel 和抢占机制是主参考；Chatty 默认不启用后台 agent task。',
  },
  {
    topic: 'terminal 读 output',
    primaryReference: 'codex',
    rationale: 'Codex 的 stdout/stderr 增量事件和输出截断策略是主参考。',
  },
  {
    topic: '基本 file I/O（读、写、搜）',
    primaryReference: 'claude-code',
    rationale: 'Claude Code 的 FileRead/FileWrite/Grep/Glob 工具目录最适合作为 file I/O 主参考。',
  },
]

export const JD_CAPABILITY_REFERENCE_CHOICES: readonly JdCapabilityReferenceChoice[] = [
  {
    topic: 'LLM API 与 KV Cache',
    primaryReference: 'codex',
    rationale:
      'Codex 的 prompt_cache_key、cached_input_tokens、token usage/budget 体系最贴近 Chatty 的 DeepSeek pro 账单与 cache 命中观测。',
  },
  {
    topic: 'Agent Loop 与 Tool Use',
    primaryReference: 'codex',
    rationale: 'Codex 的 bounded tool-call loop、审批、trace 和 fallback 是主参考。',
  },
  {
    topic: 'Reasoning 与 Planning',
    primaryReference: 'codex',
    rationale: 'Codex 的 plan/steer/turn 边界适合作为 Chatty 窄任务 planning 的上限。',
  },
  {
    topic: 'Skills 与 MCP',
    primaryReference: 'claude-code',
    rationale: 'Claude Code 的 skills、MCP、hooks 和 tool catalog 是能力目录化主参考。',
  },
  {
    topic: 'Memory',
    primaryReference: 'openclaw',
    rationale: 'OpenClaw 的 memory_search 和长期记忆检索是主参考。',
  },
  {
    topic: 'Subagent 与 Multi-Agent',
    primaryReference: 'codex',
    rationale: 'Codex 的主 agent/subagent 管理用于定义上限；Chatty 当前不实现。',
  },
  {
    topic: 'Prompt / Context / Harness Engineering',
    primaryReference: 'codex',
    rationale: 'Codex 的上下文投影、工具 schema、缓存友好 prompt 和 traceable turn 是主参考。',
  },
  {
    topic: '评测基准与数据标注',
    primaryReference: 'codex',
    rationale: 'Codex 的质量门禁、回归测试和可观测 run 是主参考。',
  },
  {
    topic: '真实任务反馈与产品指标',
    primaryReference: 'codex',
    rationale: 'Codex 的 trace、usage、analytics 事件思路适合作为真实任务反馈闭环主参考。',
  },
  {
    topic: 'UI/UX 与 demo 原型',
    primaryReference: 'claude-code',
    rationale: 'Claude Code 的终端产品体验、状态可视化和权限交互适合作为 demo/UX 主参考。',
  },
]

export const DEEPSEEK_HARNESS_COMPATIBILITY: readonly DeepSeekHarnessCompatibility[] = [
  {
    feature: 'chat_completions',
    status: 'supported',
    decision: '当前唯一 live model lane；所有真实模型调用先走 DeepSeek v4 pro Chat Completions。',
  },
  {
    feature: 'tool_calls',
    status: 'supported',
    decision: '用于 bounded search/tool loop；工具参数仍由 harness parser/policy 做容错和审批。',
  },
  {
    feature: 'json_object_output',
    status: 'supported',
    decision: '可用于 action JSON，但必须在 prompt 明确要求 JSON，且保留 parser fallback。',
  },
  {
    feature: 'thinking_and_reasoning_effort',
    status: 'supported',
    decision: 'DeepSeek 参数可作为 pro harness 调优项；默认不把 reasoning 文本暴露给业务 UI。',
  },
  {
    feature: 'context_cache_usage',
    status: 'supported',
    decision:
      '只记录 cache hit/miss、hit ratio 和 cost；优化 prompt 稳定布局，不引入私有 cache API。',
  },
  {
    feature: 'agents_sdk_custom_model',
    status: 'adoptable_via_probe',
    decision:
      '只有 custom Model/ModelProvider 能稳定调用 DeepSeek Chat Completions 时才引入 SDK lane。',
  },
  {
    feature: 'agents_sdk_function_tools',
    status: 'adoptable_via_probe',
    decision: '可复用 SDK function tools/approval 语义，但必须映射回现有 tool registry 和 policy。',
  },
  {
    feature: 'agents_sdk_sessions',
    status: 'adoptable_via_probe',
    decision: '可复用 Session 接口；业务长期记忆仍以 Chatty SQLite memory 为 source of truth。',
  },
  {
    feature: 'agents_sdk_human_in_the_loop',
    status: 'adoptable_via_probe',
    decision: '可复用 interruption/approval 形态；产品反馈仍落 agent_trace_reviews。',
  },
  {
    feature: 'openai_responses_api',
    status: 'not_assumed',
    decision: 'DeepSeek Chat Completions 兼容不等于 Responses API 兼容；当前不作为设计前提。',
  },
  {
    feature: 'openai_hosted_tools',
    status: 'not_assumed',
    decision:
      'OpenAI hosted web/file/code tools 不作为 DeepSeek harness 能力；本地工具必须由 Chatty 执行。',
  },
  {
    feature: 'openai_conversations_api',
    status: 'not_assumed',
    decision:
      '不依赖 OpenAI server-managed conversation state；Chatty SQLite session/memory 保持主权。',
  },
]

/** 判断某个外部项目是否允许作为 Chatty agent 架构设计参考源。 */
export function isAllowedArchitectureReference(value: string): value is ArchitectureReference {
  return value === 'openclaw' || value === 'codex' || value === 'claude-code'
}

/** 将参考选择转成按主题索引的对象，方便文档生成或测试做精确断言。 */
export function getPrimaryReferenceByTopic(): Record<
  AgentArchitectureTopic,
  ArchitectureReference
> {
  return Object.fromEntries(
    AGENT_ARCHITECTURE_REFERENCE_CHOICES.map((choice) => [choice.topic, choice.primaryReference]),
  ) as Record<AgentArchitectureTopic, ArchitectureReference>
}

/** 将新版 JD 能力项转成按主题索引的对象，方便测试约束每项只选一个参考源。 */
export function getPrimaryReferenceByJdCapability(): Record<
  JdCapabilityTopic,
  ArchitectureReference
> {
  return Object.fromEntries(
    JD_CAPABILITY_REFERENCE_CHOICES.map((choice) => [choice.topic, choice.primaryReference]),
  ) as Record<JdCapabilityTopic, ArchitectureReference>
}

/** 将 DeepSeek harness 兼容性结论转成按能力索引的对象，方便测试和文档生成。 */
export function getDeepSeekHarnessCompatibility(): Record<
  DeepSeekHarnessFeature,
  DeepSeekHarnessFeatureStatus
> {
  return Object.fromEntries(
    DEEPSEEK_HARNESS_COMPATIBILITY.map((item) => [item.feature, item.status]),
  ) as Record<DeepSeekHarnessFeature, DeepSeekHarnessFeatureStatus>
}
