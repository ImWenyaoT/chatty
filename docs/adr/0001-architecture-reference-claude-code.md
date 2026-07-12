# ADR 0001 — 架构主参考从 codex 切换为 claude-code

- 状态：Accepted（2026-07-12）
- 取代：commit `0f73c62`（consolidate architecture reference to codex-only）
- 影响面：`CONTEXT.md` 词汇表、`apps/web/lib/context-control.ts` 注释、CI 源码扫描约束

## 背景

Chatty 是一个客服 Agent 的 harness（确定性任务调度 + 有界工具循环），模型走 DeepSeek 的
OpenAI 兼容 Chat Completions 端点，工具循环用 OpenAI Agents SDK 承载。此前仓库把
`ArchitectureReference` 收敛为 `codex` 唯一（每个能力项以 Codex 为主参考、复杂度上限指向
Codex 源码树）。

本次决定把架构主参考**整体切换为 `claude-code`**，理由：

1. **JD 信号**：`docs/jd.md` 任职要求明确点名应深度使用 **Claude Code**（技术/产品两个方向都列）。
2. **参考物匹配度**：Codex 是 coding-CLI；Claude Code 是一个通用 **harness**，其 query 循环、
   工具生命周期、subagent、hook、渐进披露等形状与 Chatty 客服 harness 的目标同构度更高。
3. **单一参考原则**：仓库沿用"每能力单选一个主参考"的既定结构，本次只是把这个唯一值从
   codex 翻成 claude-code，不引入 reference soup。

参考物快照：`/home/ail510/tian_wenyao/projects/oss/claude_code`（完整 Claude Code 源码树）。

## 决策

### 1) 参考登记整体切换（决策登记层，行为无关，eval 安全）

- `ArchitectureReference` 类型：`"codex"` → `"claude-code"`（claude-only）。
- 全部 18 个架构 topic + 10 个 JD 能力 topic 的 `primaryReference` → `claude-code`，rationale
  逐条改写为 claude_code 实证表述（引用具体子系统，见下表）。
- **复杂度天花板也切到 Claude Code**：开发时以当前机器的
  `/Users/edward/Documents/oss/claude-code` 为代码参考；仓库不登记不可移植的本机绝对路径。
- 当前架构文档只允许 Claude Code 作为主参考；源码测试直接扫描现行文档，避免维护一份只验证自身的静态登记表。

> 形状参考 ≠ 复杂度许可。天花板虽升到 Claude Code（比 codex 大得多），但
> `upperBoundAction: "delete-before-optimizing"` 与 MVP 控重量原则不变——Claude Code 的重型资产
> （见下"坚决不碰"）本就在客服 harness 边界之外，天花板抬高不等于放行 bloat。

### 2) DeepSeek 真实兼容矩阵（约束 SDK 可用面，已核官方文档 2026-07）

| 能力 | DeepSeek 真实支持 | Chatty 现状 | 判定 |
|---|---|---|---|
| 模型名 | `deepseek-v4-pro` / `v4-flash`，1M 上下文、384K 输出；`deepseek-chat`/`reasoner` 2026-07-24 弃用 | 代码 pin `deepseek-v4-pro` | ✅ |
| function calling | 非 strict 走标准端点；**strict 仅 `/beta`** | 标准端点 + `strict:false`，参数交执行器 policy | ✅ |
| JSON | 支持 `json_object`；**无 `json_schema`**；需 prompt 含 "json" | fetch 补丁把 `json_schema→json_object`，Agents SDK structured runner 用 Zod 校验 | ✅ |
| context/KV cache | 自动、best-effort，字段 `prompt_cache_hit/miss_tokens` | usage-telemetry 归一化 | ✅ |
| thinking | `thinking:{type:enabled\|disabled}` + `reasoning_effort` | `providerData:{thinking:{type:"disabled"}}` | ✅ |
| Responses API | 不兼容 | 标 `not_assumed`，强制 `OpenAIChatCompletionsModel` | ✅ |

结论：现有三处"SDK 套 DeepSeek"兼容补丁（`strict:false` / `json_schema→json_object` /
`thinking:disabled`）逐条对得上官方文档。这一层扎实，本次不动。

### 3) SDK / Chat Completions 分层（不变）

两条 lane 最终都走 Chat Completions 线格式（DeepSeek 只认这个，Responses API 排除）：

```
Agents SDK lane  ─┐  Agent/run/tool/outputType
                  ├─→ OpenAIChatCompletionsModel ─→ openai client ─→ DeepSeek /chat/completions
ChatCompletions  ─┘  client.chat.completions.create（裸调，仅 eval/抽取/fallback）
lane
```

live runtime 必须走 Agents SDK；源码扫描测试禁止 `apps/` 与 `packages/agent-core/` 直接编排
Chat Completions。裸调只保留在 `eval/`；生产 DeepSeek 仍由 Agents SDK 的
`OpenAIChatCompletionsModel` 走 `/chat/completions`。此约束不变。

## claude_code 子系统 → Chatty 参考映射（rationale 依据）

| Chatty 能力 topic | Claude Code 参考（路径/机制） | 借鉴要点 |
|---|---|---|
| loop 和流程控制 / Agent Loop | `query.ts` async generator + 不可变 State + 命名 transition/return reason | 每个继续/终止带枚举理由，可审计可测；`maxTurns` 单点强制 |
| task scheduling / Subagent | `tools/AgentTool/runAgent.ts` + `loadAgentsDir.ts`（AgentDefinition） | run policy 落地形态 = 收窄工具池 + 独立 maxTurns/toolChoice/系统提示 的递归 query；派生 scoped context 时按 allowedTools 收窄权限 |
| 执行器 executor | `services/tools/toolExecution.ts` runToolUse + `toolOrchestration.ts` partitionToolCalls | 单次流水线：校验→PreToolUse→权限→call→PostToolUse→整形；`isReadOnly/isConcurrencySafe` 驱动"只读并行、写串行" |
| 策略/审计（executor 挂点） | `types/hooks.ts` + `services/tools/toolHooks.ts` | Pre/Post/Stop 三挂点，hook 返回 `updatedInput/additionalContext/deny`；合规校验与脱敏挂在工具外 |
| skills 和 plugins / Skills 与 MCP | `skills/loadSkillsDir.ts`（SKILL.md frontmatter）+ `Tool.shouldDefer`/ToolSearch | 声明式能力注册 + 渐进披露（先摘要后详情），对 DeepSeek 省 token |
| context auto compression | `services/compact/*`（microCompact/autoCompact） | microcompact 清空老 tool_result 正文（保结构保 cache）；阈值=窗口−buffer；压缩后按预算重注 |
| long-term memory / Memory | `memdir/`（findRelevantMemories + memoryAge） | 会话结束抽取 → 下次开场相关性预取注入两段式 |
| 可观测性 / 反馈指标 | `query.ts` yield typed 事件流 + `cost-tracker.ts` | trace 流与 metrics 累加器分离 |
| terminal/sandbox/file/background | `tools/*`（Bash/FileEdit/Grep）+ `hooks/useCanUseTool.tsx` 三态权限 + `run_in_background`/Task | Chatty 无终端，映射为业务 side-effect 工具 + 审批；MVP 不启用后台 agent task |

**坚决不碰（claude_code 重型资产，客服 MVP 边界外）**：Anthropic 专属模型层
（betas/cache_control/token-budget 恢复分支）、远程/bridge/worktree 编排、Ink TUI 渲染层、
生成式 autoCompact 摘要（留到有金标 eval 验证后再评估）。

## Phase 3：runtime 深化 backlog（improve-codebase-architecture 扫描结论）

以 claude code 为 best-practice 透镜、对 chatty 现有代码跑了一轮 deepening/deletion 扫描
（deletion test：删掉浅模块是"集中"还是"搬走"复杂度）。结论**优先删除/深化，而非新增**
（薄 agent 不该加 hook bus / pipeline，那是 overdo）。金标闸：`pnpm eval`（15 golden YAML）。

| # | 候选 | 类型 | 验收 | 状态 |
|---|---|---|---|---|
| 1 | **折叠 harness 双 lane、删掉 compose 通路** | 删除（~250-300 行 + 死 lane 纯函数） | sdk-lane 分数 ≥ compose 基线（8/14），前后 `pnpm eval` 对拍 | **✅ 8/14 后删除** |
| 2 | sdk lane 的 search 归位到 `executeSearchRequest`（去重/精炼/审计单一缝） | 深化 | interface 单测 + 金标 | **✅；金标可完整执行** |
| 3 | 生产 SDK runner 装配抽可测缝（`buildSdkPrompt`/`actionForTask` 已导出单测） | 深化 | in-process 单测 | **✅ 已做** |
| 4 | Context Control 收窄接口（三快照与 trace 边界上收成深模块） | 深化 | SQLite interface 单测 | **✅ `prepareTurnContext`** |
| 5 | `HarnessRunController` 删透传方法 + abort registry 注入 | 混合 | 单测 | Speculative |

**进展校正（2026-07-12）**：`eval/run.ts` 已与 `apps/web` 复用
`createCustomerServiceSdkRunner` + Agents SDK text runner，金标现在直接执行生产 lane；compose 只保留为
无 key 的确定性 fallback。生产 runner 也已有离线 interface 测试，覆盖 search 精炼/去重、policy 拒绝、
取消前 attempted 审计与 context/trace 一致性。

**#1 执行进展（分阶段、避免 mess up）**：
- **1a ✅**：生产 runner 胶水抽成共享 `createCustomerServiceSdkRunner`（`packages/agent-core/src/customer-service-sdk-runner.ts`，SDK 具体调用注入以保持 agent-core SDK-free），`apps/web` 与 `eval` 复用同一份。附带**修好一个生产潜伏 bug**：`@openai/agents` 要求 zod 参数必须 strict，而 DeepSeek 标准端点非-strict，改为给 SDK 传 `z.toJSONSchema(...)` 纯 JSON schema、内部仍用 zod `.parse` 校验。有 in-process 单测（假注入 runner）。
- **1b ✅**：生产 sdk lane 改为一轮有界工具阶段；Agents SDK 的公开 `toolUseBehavior` 在首个工具结果后
  结束该 run，再用无工具 SDK run 生成最终回复。确定性 repro 从 4 轮 `MaxTurnsExceededError` 收敛为
  2 次模型采样；原失败场景不再出现 maxTurns 或 DSML 工具协议泄漏。
- **1c ✅**：2026-07-12 生产 SDK lane 全量 14 条达到 8/14，与既定 compose 基线持平；随后删除
  compose instructions、自建 Chat Completions 工具循环、JSON action parser/executor、确定性 fallback
  及其专属测试。其余金标失败继续作为客服行为质量问题处理，不再保留第二套运行协议兜底。

**端点探针实测（2026-07-12，已排除一个假设）**：直连 DeepSeek 两端点测 `response_format`——
`json_object` 在标准端点与 `/beta` 都 ✅ 正常返回 `{"reply":"..."}`；`json_schema`（真结构化
输出）在**两端点都 400 `This response_format type is unavailable now`**。即 **`/beta` 不解决问题**
（它只加 strict function calling，不加 structured output），现有 `json_schema→json_object` 重写补丁
是唯一可行路径且 json_object 本就能吐对格式。生产客服 runner 已移除 `outputType`，改用 text runner；
历史 maxTurns 根因是 Agents SDK 默认 `run_llm_again` 会在每轮继续暴露同一工具集，DeepSeek 因而反复
调用工具或把 DSML 工具调用标记输出成普通文本。当前一轮工具预算已从运行时消除该失败模式。

**下一步**：只围绕现有 14 条金标修客服行为与事实命中，不新增 planner、hook bus 或第二个 agent。

## 后果

- 决策登记与文档整体一致（`grep -i codex` 在 src/docs 无残留），`pnpm lint` 0 error、
  core coverage **163 test 全绿**、全 workspace typecheck 通过。
- 已做 runtime 改动：候选 #2/#3/#4 + **#1a（共享 runner 抽取 + 修 strict 潜伏 bug）** + DeepSeek 兼容补丁分支测试。
- **关键实测发现**：生产 sdk 客服 lane 的 maxTurns/DSML 泄漏已通过 SDK 公开 seam 修复；达到既定
  8/14 门槛后双 lane 已删除，金标现在只暴露价格事实、slot 收集与下单引导等行为差距。
- 若未来要多 provider，claude_code 不是好范例（它是单 provider 硬编码），需另行设计接口。
