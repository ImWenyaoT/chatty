# Chatty 领域词汇

## Chatty

Chatty 是面向电商推荐与营销场景的单 Agent。它根据用户画像选择有库存的商品，检索相关知识，并生成个性化推荐理由和营销文案。

## Single Agent

Chatty 是 Single Agent，判据是：**只有一个 Agent 参与对话循环、持有对话历史、对用户可见**。

判据不是「进程里只有一次 Model 调用」。Harness 可以确定性地发起其他 Model 调用（见 Subagent），
只要它们不参与对话循环、不由主 Agent 决定何时触发，Single Agent 就成立。这条判据是可验证的：
主 Agent 的 `tools` 数组里不含任何 Subagent，`handoffs` 为空，由测试钉住。

## Agent

Chatty 的概念定义是 `Agent = Model + Harness`。Model 负责开放式判断；Harness 是 Model
之外的运行环境，负责准备 Context、提供并执行 Tool、运行 Agent Loop、实施 Control 并保存
Evidence。Context 和 Tool 属于 Harness 管理的运行时内容，不是与 Model、Harness 并列的
Agent 一级组成部分。

## Subagent

由 Harness 确定性调用的单次 Model 调用，有自己的 instructions 和输出契约，但不参与对话循环、
不持有对话历史、不能调用 Tool、对主 Agent 不可见。当前有两个：`task_framer` 把用户原话抽取成
TaskFrame，`draft_corrector` 在 provider 不遵守 schema 时把最终文本改写回结构化契约。

Subagent 不构成 Multi-Agent，因为不存在 handoff，也不存在由 Model 决定的委派。这与 eve 的
Subagent 语义有一处**明确分歧**：eve 的 Subagent 会降解成 parent 可见的 Tool，由 parent Model
读它的 description 决定是否委派；chatty 的 Subagent 只有 Harness 能触发。沿用同一个词是为了
对齐目录约定，触发方不同必须写明。

## Model

Agent 中负责理解自然语言、选择开放 Tool 和生成表达的部分。当前 Model 通过 OpenAI Agents SDK
调用 DeepSeek Responses API；Model 不拥有商品价格、库存或最终事实裁决权。

## Harness

Agent 中位于 Model 外部的确定性运行环境。Harness 准备 Context，提供并执行 Tool，控制循环、
会话与调用上限，保存 Model 不可见的 Evidence，并在输出前依据 SQLite 重查和校验事实。

## Tool

Harness 向 Model 提供或替 Model 执行的能力。Tool 接收明确输入并返回结果，本身没有独立目标、
Context 或决策循环，因此不是 Agent。

## 用户

发起一次推荐请求的人。用户由稳定的 `user_id` 标识；请求可以携带近期浏览、近期购买、偏好类目和价格区间。

## 用户画像

对用户当前推荐偏好的结构化描述，包括用户分群、偏好类目、可接受价格范围和近期行为。用户画像是推荐依据，不是永久身份结论。一次成功推荐后，用户本轮明确选择的类目会成为下一次画像偏好；用户本轮明确需求始终优先于历史画像。

## 商品

可被推荐和售卖的目录条目。商品拥有稳定编号、类目、售价、库存、标签和热度。Chatty 不处理租赁商品。

## 库存

商品当前可售数量。库存为零的商品不得进入推荐结果；低库存只作为提示，不代表缺货。

## 知识文档

用于解释商品适用场景、选购原则、营销表达或配送与退换货政策的演示文本。知识文档不能覆盖商品价格、库存等结构化业务事实。

## 知识检索

Agent 根据当前问题主动召回相关知识文档的过程。通用检索支持政策回答，商品范围检索支持推荐理由和营销文案；检索结果不直接决定最终商品集合。

## 会话

一次推荐请求从开场到给出推荐的完整过程。会话可能只有一轮，也可能包含若干次澄清。会话持有历史与轮次上限；每一轮的证据不跨轮累积。

## 澄清

信息不足时 Chatty 先反问而不推荐。澄清轮不校验推荐商品字段，但仍需由 Evidence 证明
必要 Tool 已完成，并区分“没有候选商品”和“候选商品没有库存”。

## 推荐

Chatty 根据用户画像、商品信息、检索知识和库存产生的有序商品集合。推荐理由解释商品与用户需求的关系，不得虚构价格、库存或优惠。

## 营销文案

与单个推荐商品绑定的短文本。文案根据用户分群和检索知识采用合适语气，并受禁词约束。文案不是广告投放或平台发布。

## Project Structure

仓库是单包，顶层目录按领域切分（`agent/` `data/` `server/` `web/` `evals/` `tests/`），
布局理由见 ADR 0004。`agent/` 内部采用 eve 的 Project Layout slot 约定：

| slot | chatty |
| --- | --- |
| `agent.ts` | 主 Agent 的 Model、Tool 与输出契约 |
| `instructions.md` | 主 Agent 系统提示词 |
| `tools/` | 模型可调用的 Tool，一文件一个 |
| `subagents/` | `task_framer` 与 `draft_corrector`，各自带 `agent.ts` + `instructions.md` |
| `lib/` | 只供 import 的共享代码，不构成任何 slot |

核心约定是**路径决定身份**：`agent/tools/<name>.ts` 就是名为 `<name>` 的 Tool，Tool 文件里
没有 `name` 字段（`defineTool` 的类型里就没有这个字段）。加一个文件就是加一个 Tool，
不存在需要同步的注册表。共享代码必须放 `lib/`——`tools/` 下的每个 `.ts` 都会被当成一个 Tool。

不采纳的 eve slot 及原因：

- `channels/` — 只有一个 HTTP 面，单文件目录是仪式。
- `sandbox/` — 没有代码执行需求。
- `skills/` — eve 的 Skill 是 Markdown；营销策略数据在 SQLite，不是文档。
- `schedules/` `connections/` `hooks/` `instrumentation.ts` — 均在 MVP 边界外。

空目录不建：用得上的 slot 严格照做，用不上的在这里写明为什么不做。
