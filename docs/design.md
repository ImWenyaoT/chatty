# Chatty Harness Design Map（The Harness Is The Product）

> Agent = Model + Harness。model 是厂商的，我们真正 DIY 的是 harness。
> 本文按固定的 harness 关注点清单逐点回答"chatty 怎么落实 / 为什么不做更多"。
> 描述约定：每点先给 **Shape（输入 → 输出）**——组件像深度学习的层一样，shape 对上即可替换，
> data flow 中间的任何组件都可以排列组合换来换去。
>
> **维护规则：改动任何 harness 组件的提交必须同步更新对应小节（living doc）。**
> Last updated: 2026-07-04（agentic search 已上线为当前知识检索路径；embedding/qdrant
> 检索子系统与评测飞轮已退役，规格见 agentic-search-design.md）

## 1. agent 核心功能

### 1.1 task scheduling 拆分（multi-agent）

- **Shape**：`(utterance, session snapshot) → CustomerServiceTask`
  （5 种窄任务：collect_missing_info / answer_question / check_availability / handoff / follow_up）
- **现状**：`packages/agent-core/src/customer-harness.ts` 的 `scheduleCustomerServiceTask`，
  确定性规则调度，task 由 harness 步内部计算并经 trace 回传。
- **可替换**：换成 LLM 分类器不改 shape——调用方只认 `CustomerServiceTask`。
- **简化决策**：单 agent、无 multi-agent。客服场景一轮一任务够用；JD 考察的是 harness 分层，
  不是 agent 数量。

### 1.2 loop 和流程控制（可视化、可观测性、GUI）

- **Shape**：`(task, context, modelFn?) → {reply, terminal, toolCalls, memoryPatch, trace}`
- **现状**：`runCustomerServiceHarnessStep` 单步有界 harness；compose 步内已上线
  **≤3 次 search 的有界工具循环**（`MAX_SEARCH_CALLS=3` 硬编码，到顶注入"工具已禁用"强制作答，
  任何失败回退确定性 composer——"无 key 可跑"是不变量）。
- **可观测 / GUI**：每步 trace 落 SQLite（`trace-repository`），playground 页即 GUI inspector
  （task / action / tool 调用 / context fragments / memory 全展开）；dashboard 是卖家后台演示视图
  （会话/知识面板走演示数据）。质量回归由 `pnpm eval --target harness` 的朴素金标承担，
  不再有"每条回复自动评分"的飞轮。
- **简化决策**：无 durable workflow 引擎（Temporal 否决记录在 tech-stack-decisions）；
  轮数上限是常量不是配置项——调整需金标证据。

### 1.3 input 拼接 prompt（long-term memory / skills / context compression）

- **Shape**：`(customer, product, memory snapshot, policy[, knowledge]) → ContextFragment[] → prompt`
- **现状**：`buildCustomerServiceContext` 显式拼装；**long-term memory** = SQLite 仓
  （`memory-repository`，`commitTurn` 单事务多表原子提交），快照进 context；
  `kind:'knowledge'` fragment 已上线（FTS5 检索结果，取代已退役的 legacy embedding 检索）。
- **compression**：recentMessages 滑窗截断（有测试钉住）。无 auto-compression——
  客服会话规模用不上，见好就收。
- **skills/plugins**：不做（决策记录：runtime 概念不叫 skills，tech-stack-decisions §5）。
- **No-RAG 立场**：tech-stack-decisions §11（memory + FTS 索引/摘要 + agent 搜索工具）。

### 1.4 output parser

- **Shape**：`模型输出 string → CustomerServiceAction`（严格 JSON + 确定性回退）
- **现状**：`parseCustomerServiceOutput` 逐字段容错校验；adapter 层 `completeJson`
  抗 fenced 代码块/夹杂说明文字（`apps/web/lib/llm.ts`）。
- **关键不变量**：解析失败永不抛给用户——回退确定性 composer，回复永远合法。

### 1.5 执行器 executor（可自由配置的 MCP）

- **Shape**：`CustomerServiceAction → registry.invokeWithPolicy → 工具执行/审批升级`
- **现状**：`executeCustomerServiceAction` + `tools/registry`（5 个工具，risk 分级），
  policy 硬门有测试钉死：`issue_refund` 永不自动执行、closed 会话零工具暴露。
- **MCP**：不接。in-process registry 的工具 shape（name/risk/execute[/parameters]）与 MCP tool
  同构，未来要接就是一个 adapter 的事——当前没有 JD 理由，不为不存在的未来铺路。
- **provider 配置**：OpenAI 兼容端点 + env（`CHATTY_LLM=1` 双门控），开发用 DeepSeek。

## 2. tool calling

### 2.1 terminal 执行（sandbox / background tasks）

- **刻意不做**：客服 agent 没有 terminal/file 工具（harness core 明确排除）——
  它的风险面是业务动作（退款/工单），不是 shell，所以"sandbox"体现为工具 risk 分级 + 审批门。
- **background tasks**：无。曾有的评测飞轮 fire-and-forget 已退役（过度设计，见好就收）；
  质量回归改为离线的朴素金标（`pnpm eval --target harness`）。

### 2.2 terminal 读 output

- n/a（同上，无 terminal 面）。

### 2.3 基本 file I/O（cat、sed、rg 的对应物）

- 客服场景的"rg" = **知识检索**：`search_knowledge` 已上线（FTS5 trigram MATCH + 中文 2 字词
  LIKE 回退，top-3 服务端固定，单参数 `query`）。
- **Shape**：`query → 三段式纯文本（找到 N 条 → 来源+正文 → "还有 N 条，换更具体关键词"）`
- 完整规格与中文分词实测记录：[agentic-search-design.md](agentic-search-design.md)。

## 附：与参考仓的形态对标

chatty 的产品形态对标 **openclaw**（消息渠道上的对客 conversational assistant）：
记忆参与回复、会话内有界工具循环、"必须先搜索不要凭记忆回答"的工具触发条款。
search 工具的机制层（schema/截断/描述文案）参考 coding agents（claude_code/codex/opencode/pi）。
复杂度上限即参考仓，理应更简，dont ever overdo。
