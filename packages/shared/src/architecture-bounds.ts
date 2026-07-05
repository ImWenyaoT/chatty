export type ArchitectureReference = 'openclaw' | 'codex' | 'claude-code'

export type LlmBillingCacheReference = 'opencode'

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

export type LlmBillingCacheDesignChoice = {
  readonly primaryReference: LlmBillingCacheReference
  readonly rationale: string
}

export const ARCHITECTURE_COMPLEXITY_POLICY = {
  target: 'stay-inside-bounds',
  lowerBoundAction: 'raise-to-jd-and-prd',
  upperBoundAction: 'delete-before-optimizing',
  rule: '低于 jd.md + PRD.pdf 的能力要补到下限；超出 OpenClaw/Codex/Claude Code 区间且不能服务客服 harness 的实现先删除，不做优化。',
} as const

export const AGENT_COMPLEXITY_BOUNDS = {
  lowerBound: ['docs/jd.md', 'PRD.pdf'],
  upperBound: [
    '/Users/edward/Documents/oss/openclaw',
    '/Users/edward/Documents/oss/codex',
    '/Users/edward/Documents/oss/claude-code',
  ],
} as const

export const LLM_BILLING_CACHE_DESIGN_CHOICE: LlmBillingCacheDesignChoice = {
  primaryReference: 'opencode',
  rationale:
    'opencode 的 LLM design 把 usage、cache read/write 和 estimated cost 归一到 model run result，最贴近 Chatty 的 DeepSeek pro 账单观测。',
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
