# Chatty MVP 架构 Spec

Last updated: 2026-07-04
Status: **重写设计提案（编号 RW-1，未实施）** — 本文档是 legacy `rag-service` 推倒重写的目标架构设计。
曾按 §2/§3 平移出 `packages/domain` 代码骨架，但骨架从未接入 playground / 金标评测等生产路径，
已于 2026-07 的 cleanup 中整包移除；设计本身保留，作为架构决策记录。
若重启 RW-1：按本文档推进，以 §9 验收清单为完成定义；届时 `rag-service/` 从 main 删除（完整历史在 `legacy-extras` 分支）。

## 0. 设计原则

1. **Specs-driven，自顶向下**：features → 架构 → 接口 → 实现，每层先定契约再写代码。
2. **行为契约不变，实现全换**：23 种 Action、阶段词汇、profile 字段、11 个金标场景
   是验收闸门；重写前后金标 YAML 一字不改（仅明确记录的两处行为修复除外，见 §8）。
3. **LLM 全部走注入端口**：领域引擎是纯 TS + 注入接口，任何模块可以用 stub 离线测试。
4. **确定性优先、LLM 受限**：fast-path 规则先行，LLM 只做受限兜底（强制 tool_choice
   四选一、生成后三层安全门），这是本项目对 Harness Engineering 的核心表达。
5. **一个月 MVP 的重量纪律**：舍弃 vision/图片通道、Qdrant、知识管理后台、Fastify、
   JSON 文件记忆库；每个保留的模块都必须服务于 loop / eval / memory / tool 四大主线。

## 1. Features（需求层）

| # | Feature | 验收方式 |
|---|---|---|
| F1 | 租衣客服多轮对话：锁品→档期→体型→尺码→库存核验→复核→引导下单→售后跟进 | 金标 11 场景结构断言（CI 离线） |
| F2 | 有界 agent loop：每请求一次路由决策，reply / handoff / tool 三种终止性 | loop 单测 + smoke |
| F3 | 工具层：风险分级（low/medium/high）+ 审批门（Agents SDK lane 已于 2026-07 删除，安全门收敛为 policy 审批） | 安全不变量单测 |
| F4 | 记忆：slot 化 ConversationProfile + 消息滑窗 + SQLite 持久化 | db 单测 + 金标 profile 断言 |
| F5 | 知识检索：本地向量库（cosine），以 low-risk tool 形态暴露给 loop | 单测（stub embeddings） |
| F6 | 评测飞轮：LLM-judge 评分 → failure_case → golden 晋升 → 回归 | smoke 真转一圈 + promote CLI |
| F7 | 观测：trace 落库（含真实 toolCalls 与 handoff 原因），playground 展示 loop 状态 | route 集成路径 + UI |

## 2. 包结构（模块层）

依赖方向严格单向（→ 表示依赖）：

```
@rental/shared ← @rental/db
      ↑              ↑
@rental/domain ← @rental/agent-core ← apps/web
      ↑              ↑
@rental/llm ────────┘
```

- **@rental/shared**：跨切类型（事件、AgentStepResult、RuntimeTool）、zod schema、auth、
  事件工具。零依赖（仅 zod）。
- **@rental/domain**（提案，重写主体；代码骨架已移除，见文首状态）：租衣客服对话引擎。纯 TS + 端口接口，
  **不 import 任何 SDK/HTTP/fs 运行时依赖**（prompts/catalog 以解析好的对象注入）。
- **@rental/llm**：OpenAI 兼容适配器；实现 domain 的三个 LLM 端口 + embeddings +
  本地向量知识库实现（Agents SDK lane 已随 2026-07 清理删除，不在重写范围）。
- **@rental/db**：SQLite repositories（session/trace/review/failure_case/memory）。
  memory 扩展为完整 profile 持久化（conversation_profile_json 列已在 schema）。
- **@rental/agent-core**：有界 loop、意图分类、工具 registry + policy、失败用例策略、
  golden 导出。`ask_info` 通过 `DialogueEngine` 端口调用 domain（替换原 LegacyRagService）。
- **apps/web**：Next.js playground（UI + /api/playground 组合根）。
- **evals/**（根目录）：金标 YAML + runner + reports + 晋升 CLI。runner 直调 domain
  引擎（in-process）；结构断言（action/stage/profile/contains/notContains/notSameAsPrev）
  用确定性 stub 离线跑进 CI，minScore judge 断言仅在配置 LLM key 时执行。

## 3. @rental/domain 内部切分（文件层）

```
src/
  types.ts            # ConversationProfile / Action(23 kinds) / Stage / 领域类型
  ports.ts            # 全部注入端口接口（见 §4）
  catalog.ts          # 商品目录 + 尺码规则（findProduct / pickSizeByMeasurement）
  prompts.ts          # 版本化 prompt 配置形状 + sha1 promptVersion 计算（纯函数）
  parsers/
    date.ts           # 日期归一化（从 rag-service 平移，26 个单测随迁）
    measurements.ts   # 身高体重/件数抽取（同上）
  extraction.ts       # 事实抽取：regex-first + LLM 端口兜底 + 意图门控写入策略
  profile.ts          # ConversationProfile / BodyProfile 合并语义（本次补全单测）
  orchestrator.ts     # slot 状态机（纯函数，22 个单测随迁 + §8 修复）
  routing/
    rules.ts          # 有序 fast-path 规则表：Array<{name, when(ctx), act(ctx)}>
    classifier.ts     # LLM 受限分类端口的调用与解析（合并原双分类器，见 §8）
  templates.ts        # 确定性回复模板（纯函数）
  action-specs.ts     # 每 Action 的生成规格：goal/hardRules/示例/maxChars
  generation.ts       # 受限 LLM 生成 + 三层安全门 + 模板回退（answerSource 可观测）
  sanitize.ts         # 回复文本清洗（唯一实现）
  engine.ts           # createDialogueEngine(ports): answer(input) 管道编排
```

模式功课（刻意采用并在代码注释标注）：
- **有序规则表**（routing/rules.ts）替代 250 行 if 级联——规则可单测、可插拔、优先级显式。
- **端口与适配器**：domain 定义 ports，llm/db 实现，web 组合。
- **策略模式**：回复产出 = 模板策略 | 受限生成策略，由 action-spec 决定。
- **Repository**：持久化全部走 @rental/db 工厂接口。

## 4. 端口接口（接口层）

```ts
// ports.ts —— domain 对外部世界的全部依赖
export interface ClassifyPort {
  // 一次调用同时返回意图（10 类，门控事实写入）与回复模式（4 类，路由兜底）
  classify(input: { question: string; stage: Stage; recentMessages: Msg[] }):
    Promise<{ intent: UserIntent; mode: ReplyMode }>
}
export interface ExtractPort {
  // LLM 事实抽取（rentalPeriod / productIntent），regex 先行后的兜底
  extract(input: { question: string; existing?: ConversationProfile }):
    Promise<ExtractedFacts>
}
export interface GeneratePort {
  // 受限文本生成；调用方（generation.ts）负责安全门与模板回退
  generate(input: { system: string; user: string; maxTokens: number }): Promise<string>
}
export interface KnowledgeSearchPort {
  search(question: string, topK?: number): Promise<KnowledgeHit[]>
}
export interface MemoryPort {
  snapshot(key: ConversationKey): Promise<MemorySnapshot>
  commit(key: ConversationKey, patch: MemoryCommit): Promise<void>
}
```

`engine.answer()` 的输入输出与金标 runner 共享同一契约
（question/customerId/... → answer/action/stage/profile/handoff/answerSource）。

## 5. 数据与持久化

SQLite 是唯一持久层（better-sqlite3，`CHATTY_DB_PATH`，缺省 `data/chatty.db`；
测试用 `:memory:`）。JSON 文件记忆库随 legacy 删除，CHATTY_SQLITE 开关退役。
六表不变：agent_sessions / customer_memories / product_memories / agent_traces /
trace_reviews / failure_cases。memory repository 接管完整 profile 读写
（现状：新 loop 仅持久化 recentMessages，profile 写入仍在 legacy）。

## 6. Loop 与工具

Loop 现状（2026-07 清理后）：有界单步 harness（`packages/agent-core/src/customer-harness.ts`，
schedule → context → compose → parse → execute），任务词汇为 answer_question /
collect_missing_info / check_availability / follow_up / handoff。原 loop-runner
（small_talk/provide_info/ask_info 路由）与 Agents SDK lane（`CHATTY_AGENTS_SDK`）
已整体删除（见 loop-engineering-plan §16）。重写时应答类任务改走 `DialogueEngine` 端口；
知识检索按 F5 以 `search_knowledge` low-risk 工具形态暴露。
状态机实现子集仍为 active/waiting_for_user/waiting_for_human；其余状态是预留设计。

## 7. 评测方法论

- **两档运行**：`pnpm eval`（离线，stub LLM，跑结构断言，进 CI）；
  `pnpm eval:full`（真实 LLM + judge minScore，手动/eval.yml workflow）。
- 结构断言 = action/actionIn/stage/stageIn/profile 字段/contains/notContains/
  notSameAsPrev；判分断言 = minScore（--repeat 聚合抗噪，--baseline 版本对比）。
- 飞轮：trace → review → failure_case → `pnpm promote:failure-case` → evals/golden/。
- 历史报告（6/11→11/11 迭代轨迹）保留在 evals/reports/，标注产自重写前实现——
  金标场景本身是跨实现的连续性证据。

## 8. 相对 legacy 的两处刻意行为变更（其余行为等价）

1. **post_order_followup 可达**：legacy 的 decideStage 从不返回该阶段，close_loop
   是死代码（测试已钉）。重写后：orderPlacement 存在且复核完成 → post_order_followup。
2. **双分类器合并**：legacy 每轮最多 3 次 LLM 分类/抽取调用（intent 10 类 +
   decide_reply 4 类功能重叠）。重写合并为一次 ClassifyPort 调用同时返回
   {intent, mode}，每轮 LLM 调用 -1，语义不变（fast-path 命中时依旧零调用）。

风险声明：两处变更均不在金标断言覆盖内（1）或有 stub 可离线验证（2），
真实 LLM 全量金标（含 judge）需在配 key 环境跑 `pnpm eval:full` 复核 11/11。

## 9. 验收清单（重写完成的定义）

以下条目均未开始；若重启 RW-1 实施，以此为完成定义：

- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test`（全包）/ `pnpm smoke` 全绿
- [ ] `pnpm eval`（离线结构断言）11/11 场景通过并进 CI
- [ ] 覆盖率工程化：CI 输出各包行覆盖率，@rental/domain ≥ 85%
- [ ] `rag-service/` 与迁移期文档从 main 删除，README/docs 描述单一架构
- [ ] `pnpm eval:full` 在配 key 环境复核 11/11（人工步骤，重写后首个动作）
