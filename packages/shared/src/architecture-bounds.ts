export type ArchitectureReference = "claude-code";

export type AgentArchitectureTopic =
  | "task scheduling 拆分"
  | "如何实现 multi agent"
  | "loop 和流程控制"
  | "如何更好控制整个 loop 和 workflow"
  | "如何做可视化、可观测性与 terminal UI"
  | "input 拼接 prompt"
  | "如何实现 long-term memory"
  | "如何实现 skills 和 plugins"
  | "如何做好 context auto compression"
  | "output parser"
  | "执行器 executor"
  | "如何设计可以自由配置的 mcp"
  | "如何做好 eval 和自动化测试"
  | "terminal 执行"
  | "如何控制 sandbox 环境"
  | "如何管理 background tasks"
  | "terminal 读 output"
  | "基本 file I/O（读、写、搜）";

export type AgentArchitectureReferenceChoice = {
  readonly topic: AgentArchitectureTopic;
  readonly primaryReference: ArchitectureReference;
  readonly rationale: string;
};

export type JdCapabilityTopic =
  | "LLM API 与 KV Cache"
  | "Agent Loop 与 Tool Use"
  | "Reasoning 与 Planning"
  | "Skills 与 MCP"
  | "Memory"
  | "Subagent 与 Multi-Agent"
  | "Prompt / Context / Harness Engineering"
  | "评测基准与数据标注"
  | "真实任务反馈与产品指标"
  | "UI/UX 与 demo 原型";

export type JdCapabilityReferenceChoice = {
  readonly topic: JdCapabilityTopic;
  readonly primaryReference: ArchitectureReference;
  readonly rationale: string;
};

export type DeepSeekHarnessFeature =
  | "chat_completions"
  | "tool_calls"
  | "json_object_output"
  | "thinking_and_reasoning_effort"
  | "context_cache_usage"
  | "agents_sdk_custom_model"
  | "agents_sdk_function_tools"
  | "agents_sdk_sessions"
  | "agents_sdk_human_in_the_loop"
  | "openai_responses_api"
  | "openai_hosted_tools"
  | "openai_conversations_api";

export type DeepSeekHarnessFeatureStatus =
  "supported" | "adoptable_via_probe" | "not_assumed";

export type DeepSeekHarnessCompatibility = {
  readonly feature: DeepSeekHarnessFeature;
  readonly status: DeepSeekHarnessFeatureStatus;
  readonly decision: string;
};

export type DirectChatCompletionsAllowedUse =
  | "eval_judge"
  | "eval_harness_replay"
  | "json_extraction"
  | "compatibility_probe"
  | "telemetry_normalization"
  | "fallback";

export type DirectChatCompletionsExceptionPolicy = {
  readonly rule: string;
  readonly allowedUses: readonly DirectChatCompletionsAllowedUse[];
  readonly allowedSourceRoots: readonly string[];
  readonly disallowedLiveRuntimeRoots: readonly string[];
};

export type RetrievalHarnessCapability =
  "memory" | "chunk_index_summary" | "agent_search_tool";

export type DisallowedRetrievalRuntimeLane =
  "vector_database" | "embedding_rag_pipeline" | "provider_side_retrieval";

export type RetrievalHarnessStrategy = {
  readonly principle: string;
  readonly requiredCapabilities: readonly RetrievalHarnessCapability[];
  readonly disallowedRuntimeLanes: readonly DisallowedRetrievalRuntimeLane[];
};

export const ARCHITECTURE_COMPLEXITY_POLICY = {
  target: "stay-inside-bounds",
  lowerBoundAction: "raise-to-jd-and-prd",
  upperBoundAction: "delete-before-optimizing",
  rule: "低于新版 jd.md 的能力要补到下限；超出 Claude Code 区间且不能服务客服 harness 的实现先删除，不做优化。",
} as const;

export const AGENT_COMPLEXITY_BOUNDS = {
  lowerBound: ["docs/jd.md"],
  upperBound: ["/home/ail510/tian_wenyao/projects/oss/claude_code"],
} as const;

export const RETRIEVAL_HARNESS_STRATEGY: RetrievalHarnessStrategy = {
  principle:
    "DeepSeek pro model inference is strong enough that Chatty should expose deliberate memory, indexed summaries, and a search tool instead of hiding retrieval inside a vector/RAG lane.",
  requiredCapabilities: ["memory", "chunk_index_summary", "agent_search_tool"],
  disallowedRuntimeLanes: [
    "vector_database",
    "embedding_rag_pipeline",
    "provider_side_retrieval",
  ],
};

export const DIRECT_CHAT_COMPLETIONS_EXCEPTION_POLICY: DirectChatCompletionsExceptionPolicy =
  {
    rule: "Direct official OpenAI SDK Chat Completions is allowed only for eval, JSON extraction, compatibility probes, telemetry normalization, and fallback boundaries. Live Chatty Agent runtime model/tool orchestration must stay on the Agents SDK unless a DeepSeek or SDK compatibility blocker is documented.",
    allowedUses: [
      "eval_judge",
      "eval_harness_replay",
      "json_extraction",
      "compatibility_probe",
      "telemetry_normalization",
      "fallback",
    ],
    allowedSourceRoots: [
      "eval/",
      "packages/llm/src/chat-completions-adapter.ts",
    ],
    disallowedLiveRuntimeRoots: ["apps/", "packages/agent-core/src/"],
  };

export const AGENT_ARCHITECTURE_REFERENCE_CHOICES: readonly AgentArchitectureReferenceChoice[] =
  [
    {
      topic: "task scheduling 拆分",
      primaryReference: "claude-code",
      rationale:
        "以 Claude Code 的 AgentDefinition（收窄工具池 + 独立 maxTurns/toolChoice/系统提示 的递归 query）作为 run policy 落地形态主参考；Chatty 收敛为客服单轮窄任务。",
    },
    {
      topic: "如何实现 multi agent",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 subagent = 派生 scoped context + 按 allowedTools 收窄权限 的递归 query（runAgent.ts）是最贴近 task scheduling 拆分的参考；Chatty 保持同进程单层。",
    },
    {
      topic: "loop 和流程控制",
      primaryReference: "claude-code",
      rationale:
        "以 Claude Code query loop 的 async generator + 不可变 State 快照 + 命名 transition/return reason（query.ts）作为有界循环主参考。",
    },
    {
      topic: "如何更好控制整个 loop 和 workflow",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 用命名 transition.reason 显式重入 + maxTurns 单点强制 + Stop hook 收尾，作为 loop/workflow 控制面主参考。",
    },
    {
      topic: "如何做可视化、可观测性与 terminal UI",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 循环 yield 的 typed 事件流 + cost-tracker 累加聚合是可观测性主参考；Chatty 无 TUI，只取事件流形状。",
    },
    {
      topic: "input 拼接 prompt",
      primaryReference: "claude-code",
      rationale:
        "以 Claude Code 的 ToolUseContext 载体、history projection 与渐进披露上下文注入作为 prompt 拼接主参考。",
    },
    {
      topic: "如何实现 long-term memory",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 memdir 两段式（会话结束抽取 → 下次开场相关性预取注入）作为长期记忆主参考；Chatty 落到 SQLite transaction-scoped memory。",
    },
    {
      topic: "如何实现 skills 和 plugins",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 frontmatter 声明式技能注册（SKILL.md）+ 渐进披露（shouldDefer/ToolSearch）作为 skills/plugins 主参考；Chatty 收敛为客服工具注册表。",
    },
    {
      topic: "如何做好 context auto compression",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的三档压缩（microcompact 清空老 tool_result 正文 → autoCompact 摘要 → 阈值=窗口−buffer）是主参考；Chatty MVP 先做 microcompact + 尾部截断。",
    },
    {
      topic: "output parser",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 zod safeParse + validateInput/checkPermissions 分离与坏参数回喂模型自纠是 output parser 主参考。",
    },
    {
      topic: "执行器 executor",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 runToolUse 单次流水线（校验→PreToolUse→权限→call→PostToolUse→结果整形）+ isReadOnly/isConcurrencySafe 并发分区是执行器主参考。",
    },
    {
      topic: "如何设计可以自由配置的 mcp",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 frontmatter mcpServers/工具目录 + deny 规则装配期过滤作为可配置工具面主参考。",
    },
    {
      topic: "如何做好 eval 和自动化测试",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 hook 断言、typed 事件流可回放与确定性工具管线可测性作为测试体系主参考。",
    },
    {
      topic: "terminal 执行",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 BashTool + canUseTool 三态权限 + 长命令执行作为 terminal 执行主参考；Chatty 映射为业务 side-effect 工具。",
    },
    {
      topic: "如何控制 sandbox 环境",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 permission mode（default/plan/acceptEdits/bypass）+ 工具级 checkPermissions 分层是主参考；Chatty 映射成业务 side-effect sandbox。",
    },
    {
      topic: "如何管理 background tasks",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 run_in_background/Task 后台 turn 与 TaskStop 抢占是主参考；Chatty 默认不启用后台 agent task。",
    },
    {
      topic: "terminal 读 output",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的工具结果流式回填 + maxResultSizeChars 超限落盘截断作为输出读取主参考。",
    },
    {
      topic: "基本 file I/O（读、写、搜）",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 FileEdit/Read/Grep 工具与结果整形作为 file I/O 主参考。",
    },
  ];

export const JD_CAPABILITY_REFERENCE_CHOICES: readonly JdCapabilityReferenceChoice[] =
  [
    {
      topic: "LLM API 与 KV Cache",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 cost-tracker（token/cache 命中/时长累加聚合）与 prompt-caching 观测思路贴近 Chatty 的 DeepSeek pro 账单与 cache 命中观测。",
    },
    {
      topic: "Agent Loop 与 Tool Use",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 query loop（generator+State）+ runToolUse 工具流水线是 Agent Loop 与 Tool Use 主参考。",
    },
    {
      topic: "Reasoning 与 Planning",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 plan permission mode 与 turn 边界适合作为 Chatty 窄任务 planning 的上限。",
    },
    {
      topic: "Skills 与 MCP",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 frontmatter 声明式技能 + 渐进披露 + mcpServers 配置作为能力目录化主参考。",
    },
    {
      topic: "Memory",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 memdir 抽取+相关性预取两段式作为 memory 主参考；Chatty 落 SQLite memory。",
    },
    {
      topic: "Subagent 与 Multi-Agent",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 subagent=递归 query + scoped context + allowedTools 收窄作为 Subagent/Multi-Agent 主参考；Chatty MVP 保持单层。",
    },
    {
      topic: "Prompt / Context / Harness Engineering",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 ToolUseContext 贯穿载体、渐进披露上下文注入与 hook 驱动的 context engineering 是 Harness Engineering 主参考。",
    },
    {
      topic: "评测基准与数据标注",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 hook 断言与 typed 事件流可回放作为评测与回归主参考。",
    },
    {
      topic: "真实任务反馈与产品指标",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 trace、cost-tracker、analytics logEvent 事件思路适合作为真实任务反馈闭环主参考。",
    },
    {
      topic: "UI/UX 与 demo 原型",
      primaryReference: "claude-code",
      rationale:
        "Claude Code 的 typed event stream 与 Ink TUI 渲染、三态审批交互作为 demo/UX 可视化主参考。",
    },
  ];

export const DEEPSEEK_HARNESS_COMPATIBILITY: readonly DeepSeekHarnessCompatibility[] =
  [
    {
      feature: "chat_completions",
      status: "supported",
      decision:
        "当前唯一 live model lane；所有真实模型调用先走 DeepSeek v4 pro Chat Completions。",
    },
    {
      feature: "tool_calls",
      status: "supported",
      decision:
        "用于单 Agent 的 bounded SDK tool loop；Zod strict schema 校验参数，Chatty policy 负责业务审批。",
    },
    {
      feature: "json_object_output",
      status: "supported",
      decision:
        "用于 DeepSeek outputType 兼容传输；Agents SDK 仍以 Zod schema 校验最终输出。",
    },
    {
      feature: "thinking_and_reasoning_effort",
      status: "supported",
      decision:
        "指定 tool_choice 的任务显式关闭 thinking；不把 reasoning 文本暴露给业务 UI。",
    },
    {
      feature: "context_cache_usage",
      status: "supported",
      decision:
        "只记录 cache hit/miss、hit ratio 和 cost；优化 prompt 稳定布局，不引入私有 cache API。",
    },
    {
      feature: "agents_sdk_custom_model",
      status: "supported",
      decision:
        "已用 OpenAIChatCompletionsModel 包装 DeepSeek OpenAI-format endpoint；不切 OpenAI model。",
    },
    {
      feature: "agents_sdk_function_tools",
      status: "supported",
      decision:
        "所有在线客服工具均由 task policy 暴露为 SDK function tools（标准端点，未启用 DeepSeek beta 的 strict function calling）；执行映射回 Chatty registry、policy 和 trace。",
    },
    {
      feature: "agents_sdk_sessions",
      status: "adoptable_via_probe",
      decision:
        "可复用 Session 接口；业务长期记忆仍以 Chatty SQLite memory 为 source of truth。",
    },
    {
      feature: "agents_sdk_human_in_the_loop",
      status: "adoptable_via_probe",
      decision:
        "可复用 interruption/approval 形态；产品反馈仍落 agent_trace_reviews。",
    },
    {
      feature: "openai_responses_api",
      status: "not_assumed",
      decision:
        "DeepSeek Chat Completions 兼容不等于 Responses API 兼容；当前不作为设计前提。",
    },
    {
      feature: "openai_hosted_tools",
      status: "not_assumed",
      decision:
        "OpenAI hosted web/file/code tools 不作为 DeepSeek harness 能力；本地工具必须由 Chatty 执行。",
    },
    {
      feature: "openai_conversations_api",
      status: "not_assumed",
      decision:
        "不依赖 OpenAI server-managed conversation state；Chatty SQLite session/memory 保持主权。",
    },
  ];

/** 判断某个外部项目是否允许作为 Chatty agent 架构设计参考源。 */
export function isAllowedArchitectureReference(
  value: string,
): value is ArchitectureReference {
  return value === "claude-code";
}

/** 将参考选择转成按主题索引的对象，方便文档生成或测试做精确断言。 */
export function getPrimaryReferenceByTopic(): Record<
  AgentArchitectureTopic,
  ArchitectureReference
> {
  return Object.fromEntries(
    AGENT_ARCHITECTURE_REFERENCE_CHOICES.map((choice) => [
      choice.topic,
      choice.primaryReference,
    ]),
  ) as Record<AgentArchitectureTopic, ArchitectureReference>;
}

/** 将新版 JD 能力项转成按主题索引的对象，方便测试约束每项只选一个参考源。 */
export function getPrimaryReferenceByJdCapability(): Record<
  JdCapabilityTopic,
  ArchitectureReference
> {
  return Object.fromEntries(
    JD_CAPABILITY_REFERENCE_CHOICES.map((choice) => [
      choice.topic,
      choice.primaryReference,
    ]),
  ) as Record<JdCapabilityTopic, ArchitectureReference>;
}

/** 将 DeepSeek harness 兼容性结论转成按能力索引的对象，方便测试和文档生成。 */
export function getDeepSeekHarnessCompatibility(): Record<
  DeepSeekHarnessFeature,
  DeepSeekHarnessFeatureStatus
> {
  return Object.fromEntries(
    DEEPSEEK_HARNESS_COMPATIBILITY.map((item) => [item.feature, item.status]),
  ) as Record<DeepSeekHarnessFeature, DeepSeekHarnessFeatureStatus>;
}
