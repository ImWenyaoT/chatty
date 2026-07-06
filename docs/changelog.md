# Chatty Changelog

本文件记录和新版 JD 对齐的架构、测试、可观测性改动。发布级变更仍以 git commit 为准。

## 2026-07-06

### Legacy memory fallback deletion

- 变更：删除 `MemoryRepository` 的 `memory-store.json` read-only fallback、相关类型和测试；SQLite JSON columns 成为 memory 唯一读写路径。
- 设计选择：删除大于优化；不再维护已经退出主线的 legacy 迁移兼容代码，也不为它继续做包装或抽象。
- JD 对齐：贴合 Memory 与 Harness Engineering，但保持 less is more：只保留当前 agent loop 实际需要的 memory source。
- 自动验证：`packages/db/src/db.test.ts` 继续覆盖 SQLite snapshot、recentMessages 滑窗、完整 memory 字段和事务原子性。

### Customer Service Turn use-case extraction

- 变更：新增 web 层 `Customer Service Turn` use-case module，`/api/playground` route 只保留鉴权、JSON parse 和 schema parse，客服回合的 session、memory、harness、trace、continuity 写入统一收束到模块内。
- 设计选择：参考 Codex 的 adapter/use-case 分层风格，把 HTTP 边界降成薄 adapter；暂不缩 harness external interface，也不改 model、context、memory 或 multi-agent 设计。
- JD 对齐：贴合 Agent Loop、Tool Use、Memory、Prompt / Context / Harness Engineering；后续复盘时可以直接讲清楚一次 seller-side turn 如何从输入进入 harness，再落到可观测 trace 和下一轮 memory。
- 自动验证：新增 `apps/web/lib/customer-service-turn.test.ts`，覆盖创建 session、写 trace、返回 harnessTrace、追加 recentMessages continuity，并继续用 web route 测试锁住 API 行为。

### Search Execution seam deepening

- 变更：新增 agent-core `Search Execution` module，统一低层 tool loop 与 Agents SDK function tool 的搜索执行路径。
- 设计选择：Search Execution 归 harness 拥有；SDK/web adapter 只转发 search request，不再复制 query refinement、duplicate guard、policy gate、context fragment 和 searchTrace 写入逻辑。
- JD 对齐：贴合 Tool Use、Memory、Prompt / Context / Harness Engineering；把 agent search tool 变成可观测、可测试、可复用的 harness seam。
- 自动验证：`packages/agent-core/src/search-execution.test.ts` 覆盖 refined query 去重、bad args 不写 trace、executed result 携带 fragment/toolCall/toolResult；既有搜索循环和 web LLM 测试继续通过。

### Retrieval strategy clarified around model inference

- 变更：把知识访问策略明确为“正确使用 memory、chunk/index/summary、agent search tool”，并清掉活代码注释里的 `RAG evidence` 历史措辞。
- 设计选择：DeepSeek pro 的推理能力是主资源，harness 应该给模型提供可检索、可追踪、可总结的材料，而不是把判断藏在 vector database 或 embedding RAG pipeline 里。
- JD 对齐：贴合 Memory、Tool Use、Prompt / Context / Harness Engineering，以及未来 Subagent / Multi-Agent fuzzy search 的方向。
- 自动验证：`packages/shared/src/architecture-bounds.test.ts` 锁住禁用 vector/RAG runtime lane，并要求 memory、chunk/index/summary、agent search tool 三项能力。

### Agents SDK lane naming cleanup

- 变更：把 web 层 direct Chat Completions helper 重命名为 low-level adapter utility，明确它只服务 JSON extraction、telemetry、eval 和 adapter tests，不是 live runtime lane。
- 设计选择：有 DeepSeek key 的 playground 继续默认走 Agents SDK；旧 LLM/SDK env 开关不在当前代码和当前文档中保留。
- 自动验证：`apps/web/lib/llm.test.ts` 继续锁住有 key 即 `agents-sdk`、`createPlaygroundToolLoopFn()` 不暴露 direct loop。

### Reference-bound development method

- 变更：新增 `docs/development-method.md`，把“参考实现三选一”和“搭积木复现法”写成 repo 级开发方法，并在 `AGENTS.md`、`CONTEXT.md` 和 `packages/shared/src/quality-gates.ts` 中建立入口与契约。
- 设计选择：参考 `ask-matt` 的 idea → ship 路线，先用 glossary 固定语言，再用 TDD 把流程要求落成 shared quality contract；不改 harness、model 或 agent 行为。
- JD 对齐：确保未来功能先贴近 `docs/jd.md` 的 DeepSeek Harness 要求，再从 `openclaw`、`codex`、`claude-code` 单选一个主参考，避免低于下限或超出上限。
- 自动验证：`packages/shared/src/quality-gates.test.ts` 覆盖允许参考源、单选参考、最小复现和文档入口。

## 2026-07-05

### Agents SDK adoption for DeepSeek harness

- 变更：重新引入 `@openai/agents`，`@rental/llm` 用 `OpenAIChatCompletionsModel` 包装 DeepSeek OpenAI-format endpoint，并把 Chatty runtime tool 转成 SDK function tool。
- 设计选择：能交给 SDK 的模型/tool orchestration 交给 SDK；task scheduling、business policy、tool executor、memory、knowledge fragment 和 persisted trace 继续由 Chatty harness 拥有。
- JD 对齐：把 `agent = model + harness` 落成真实代码：model 是 `deepseek-v4-pro`，harness 通过 SDK 兼容层对齐 DeepSeek，而不是为 OpenAI model 设计。
- 自动验证：`packages/llm/src/agents-sdk-adapter.test.ts` 覆盖 SDK model/tool adapter；`packages/agent-core/src/customer-harness.test.ts` 锁住 modelFn 可接收 harness runtime；`apps/web/lib/llm.test.ts` 覆盖 runtime 只由 DeepSeek key 决定，不再保留 LLM/SDK 环境开关。

### DeepSeek-first harness boundary

- 变更：明确 `agent = model + harness`，model 固定为 `deepseek-v4-pro`；`OPENAI_*` env 和 `openai` npm package 只是 DeepSeek OpenAI-format Chat Completions 的兼容层。
- 设计选择：Agents SDK 的 custom model 与 function tools 已用于兼容子集；Session、HITL 和 tracing 仍保持候选适配面；不能默认采用 OpenAI Responses、hosted tools 或 Conversations API。
- JD 对齐：把“模型与 Harness 深度适配”落到 DeepSeek Chat Completions、tool calls、JSON object、thinking/reasoning、context cache 和 usage/cost telemetry 的可验证契约。
- 自动验证：`packages/shared/src/architecture-bounds.test.ts` 锁住 DeepSeek 支持项、SDK 可探针项和 OpenAI-only 不假设项。

### Trace review feedback loop

- 变更：新增 `agent_trace_reviews`、`/api/trace-reviews`、playground 本轮复核控件和 dashboard 反馈汇总，把单条 trace 的人工判断记录为 `pass`、`fail` 或 `flagged`，并保留可统计 tags。
- 设计选择：参考 Codex 的 trace/usage/analytics 事件思路，做最小人工 review 闭环；不做自动 prompt 修改、自动金标晋升或复杂反馈平台。
- JD 对齐：补上产品方向要求里的真实任务反馈、产品指标、异常分支嗅觉和项目复盘证据；技术方向也能展示 eval/feedback loop 的工程落点。
- 自动验证：`packages/db/src/db.test.ts` 覆盖 review upsert、重复覆盖、summary 和 route-bundle external trace id；`packages/shared/src/schemas.test.ts` 覆盖 API 输入 schema；Playwright demo 验证 playground 发消息后可记录 `flagged` 复核。
- 维护：`.gitignore` 补充本地 `usage_data_*` 账单/usage 导出，避免分析文件进入公开仓库。

### New JD architecture review

- 变更：按新版 `docs/jd.md` 增加 JD 能力覆盖矩阵，把 LLM API、KV Cache、Agent Loop、Tool Use、Reasoning、Planning、Skills、MCP、Memory、Subagent、Multi-Agent、Prompt / Context / Harness Engineering、评测、真实任务反馈和 UI/UX demo 逐项映射到当前代码状态。
- 设计选择：所有当前架构参考重新收敛到 OpenClaw / Codex / Claude Code 三选一；LLM billing/cache 改选 Codex，参考其 cached input token、turn usage 和 budget 思路，不再保留其它参考源例外。
- JD 对齐：明确当前最大差距是“真实任务反馈与产品指标”仍停留在 trace/session 可回放和 demo dashboard，下一步应做最小 trace review / feedback schema，而不是扩张 agent runtime。
- 自动验证：`packages/shared/src/architecture-bounds.test.ts` 锁住新版 JD 能力项每项只有一个主参考，并重新禁止当前架构文档引用区间外参考源。

### Cache-aware LLM telemetry

- 变更：playground 的 `harnessTrace.llm` 增加 `inputCacheHitRatio`，开发调试面板直接展示 prompt/KV cache 命中率。
- 设计选择：单选 Codex 的 cached input token、turn usage 和 budget 设计，把 usage、cache hit/miss 和 estimated cost 归一到一次 harness turn 的可观测结果；不采用 Claude Code 的 Anthropic `cache_control`。
- JD 对齐：把 LLM API、KV Cache、Agent Loop 和 Harness Engineering 的理解落到可演示字段，而不是只停留在账单 CSV 分析。
- 自动验证：`apps/web/lib/llm.test.ts` 覆盖 hit/miss token 聚合后的 `inputCacheHitRatio`；`packages/shared/src/architecture-bounds.test.ts` 锁住 LLM billing/cache 仍在 OpenClaw / Codex / Claude Code 上限内。

### LLM call budget warning

- 变更：playground 的 `harnessTrace.llm` 增加 `callBudget` 和 `warnings`，默认每轮预算 3 次 LLM 调用；超过时输出 `llm_call_budget_exceeded: <calls>/<budget>`。
- 设计选择：参考 Codex 的有界 loop 和可观测 trace，不引入 durable workflow、动态路由或复杂预算调度器。
- JD 对齐：把真实 pro 模型调用从“账单事后分析”前移到每轮 demo trace，便于解释 agent 是否收敛、是否可控、是否超预算。
- 自动验证：`apps/web/lib/llm.test.ts` 覆盖默认预算、自定义预算和超预算 warning。

### Pro usage and cost trace

- 变更：真实 DeepSeek pro 调用写入 model、calls、cache hit/miss tokens、output tokens、total tokens、estimated cost CNY 和 operation list。
- 设计选择：只保留 `deepseek-v4-pro` 主线，`deepseek-v4-flash` 映射回 pro；成本优化靠少调用、短输出、trace 可观测。
- JD 对齐：MVP demo 可以直接展示 agent 的模型成本和工具循环，不需要打开外部账单 CSV 才能解释系统行为。
- 自动验证：`packages/llm/src/chat-completions-adapter.test.ts` 和 `apps/web/lib/llm.test.ts` 覆盖 telemetry 聚合和环境模型映射。
