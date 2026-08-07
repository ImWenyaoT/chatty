# Prompt、Context 与 Harness Engineering 研究笔记

观察日期：2026-08-06

## 结论先行

Chatty 不应把所有可靠性要求继续堆进 `instructions.md`。更稳妥的分工是：

- **Prompt engineering**：告诉 Model 它是谁、何时选择什么能力、怎样表达，以及哪些开放式判断由它负责。
- **Context engineering**：每轮只提供当前决策需要的信息，并为信息标注来源、时效和预算。
- **Harness engineering**：确定性地装配 Context、执行 Tool、控制循环、保存 Evidence，并用 SQLite 真值校验最终输出。

这里的关键不是 prompt 写得多完整，而是把“概率性判断”和“确定性约束”放到正确层级。

## 样本与限制

本次查看了 phistory 在观察日标记为 latest 的两个第三方捕获：

- [Claude Code 2.1.223，发布于 2026-08-05](https://phistory.cc/captures/claude-code/2.1.223/prompt.md)
- [Codex CLI 0.146.1，发布于 2026-08-05](https://phistory.cc/captures/codex/0.146.1/prompt.md)

phistory 是非官方捕获，不是厂商承诺的稳定契约；捕获还混合了 system/developer prompt、工具说明、运行环境和测试输入。因此本文只把它用于观察产品设计，不把文本当作可直接复制的模板。Claude Code 没有公开对应的完整官方 system prompt；Codex 则有[官方基础 instructions 源文件](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md)，涉及 Codex 的判断优先以后者。

本地还对照了 `../oss/codex`、`../oss/claude-code` 与 `../oss/hermes-agent` 的实现。只提取了与 Chatty 规模相称的原则：

- Codex 的 `codex-rs/core/src/context/` 把 model-visible Context 做成显式片段与状态快照；Chatty 对应保留明确的 `harness_context` 和 `agent_status`，不引入通用 registry。
- Claude Code 的 `services/compact/microCompact.ts` 会限制旧 Tool Result 对 Context 的占用；Chatty 当前会话较短，先依靠既有轮次上限和窄 Tool Result，不提前实现 compactor。
- Hermes Agent 的 `agent/system_prompt.py` 按稳定到易变的顺序装配 prompt；Chatty 同样把稳定 `instructions.md` 放在 Agent 定义中，把 RequestContext、Tool Result 与状态栏后置到每轮运行时。

这些仓库都是 coding-agent Harness，不能把文件系统、shell、权限审批和复杂 context compaction 原样迁入电商 MVP。

## 两个最新 Prompt 展现出的共同结构

### 1. Prompt 只描述模型应该怎样判断和协作

Claude Code 的主体首先说明交互身份，再说明交付、纠正、沟通和工具选择原则；Codex 的 developer prompt 也主要处理沟通风格、自治边界、文件操作规则和交付方式。它们没有把每种任务的全部业务数据塞进静态 prompt。

可迁移到 Chatty：

- 保留身份、目标、Tool 选择原则、澄清条件、事实边界和输出语义。
- 用短、可观察的规则描述行为，例如“有知识问题时调用 general 检索”，而不是解释大段实现历史。
- 不在主 prompt 重复 Tool schema、商品目录、完整领域文档或 Harness 已能强制的约束。

### 2. Context 是运行时产品，不是越多越好

Claude Code 捕获明确区分静态 Harness 说明、session-specific guidance、Memory、Environment 和动态 system reminder。官方文档也把 context window 视为主要约束：对话、文件、命令输出、项目说明和工具信息都会占用它，并会随会话推进被压缩。参见 [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)、[Explore the context window](https://code.claude.com/docs/en/context-window)。

Codex 官方仓库进一步要求 model-visible context 增量构建、单项有硬上限，并避免不必要的变化破坏 prompt cache，参见 [Codex AGENTS.md: model-visible context](https://github.com/openai/codex/blob/main/AGENTS.md#model-visible-context)。

可迁移到 Chatty：

- Context 应围绕本轮 `ParsedRequest` 装配，不应每轮重发无关画像、完整商品目录和历史 Evidence。
- `RecommendationContext`、RAG 片段和会话历史都需要明确条数/字符上限。
- 每块动态 Context 应带 provenance，例如来自 profile、SQLite 查询或 FTS5 文档；时效敏感数据还应带查询时点。
- 稳定 instructions 放前面，变化频繁的 Tool Result 放后面，便于缓存，也便于审计。
- Tool Result 应先裁剪成模型决策真正需要的字段，再进入上下文；原始结果可留在 Harness 的 Evidence/Trace。

### 3. Harness 承担确定性，而不是反复提醒 Model

Claude Code 捕获中的 `Harness` 段直接说明 permission mode、工具执行、hook 反馈和并行调用；Codex 捕获则把 sandbox、审批、文件写入、破坏性动作和持续验证写成运行规则并配套工具。这些 coding-agent 细节本身不适用于电商，但它们揭示了一个通用原则：高风险或可机械判断的规则必须有执行层。

Anthropic 官方也明确把 agent loop 描述为收集 Context、采取行动、验证结果，并把 Harness 定义为提供 Tool、Context 管理和执行环境的部分，参见 [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)。Hooks 文档进一步把 hook 定义为生命周期中的确定性控制，而非希望模型“记住”，参见 [Automate workflows with hooks](https://code.claude.com/docs/en/hooks-guide)。

可迁移到 Chatty：

- 价格、库存和商品存在性由 SQLite 查询和最终校验强制，不能只靠“不得编造”。
- `allowed_next`、`required_next`、`allowed_final_action` 属于 Harness 控制信号；prompt 只需教 Model 如何响应这些信号。
- Tool 重试上限、超时、相同 query 去重、会话轮次、Evidence 保存和 structured output 修复属于 Harness。
- Eval 应同时检查最终文本、Tool trace、SQLite grounding 和拒绝编造，而不只判断回答“像不像”。

## Coding-agent 特有与可迁移部分

| 观察 | Coding-agent 特有部分 | Chatty 可迁移原则 |
| --- | --- | --- |
| 文件搜索、补丁和 shell 工具 | 路径、行号、工作树、命令并行 | Tool 应有明确职责、窄输入和结构化结果 |
| sandbox 与 destructive-action 审批 | 删除文件、`git push`、外部发布 | 高风险动作由 Harness 授权；当前 Chatty 不含交易/发布能力，无需复制审批体系 |
| `CLAUDE.md` / `AGENTS.md` 层级 | 仓库与目录作用域 | 静态领域定义保持单一来源；运行时 Context 不复制整份文档 |
| 先读代码、执行、跑测试 | 软件工程验证闭环 | 推荐前取证，输出前重查 SQLite，并以 Eval 证明行为 |
| worktree、subagent、workflow | 并行编码和上下文隔离 | 不迁移为 Multi-Agent；Chatty 只保留 Harness 确定性调用的两个无 Tool、无历史 subagent |
| hooks | 编辑、命令、权限等生命周期事件 | 仅在出现真实生命周期控制点时使用；不要把普通 filter/guardrail 重新包装成通用 hook |
| 中间进度与最终交付格式 | 终端协作体验 | 用户可见回答保持直接，但不把内部 Evidence/控制状态暴露为营销文案 |

## 对当前 `instructions.md` 的判断

当前版本总体方向正确：篇幅短、以行为和输出契约为主，并且已经使用 `allowed_next`、`required_next` 和 `allowed_final_action` 把控制权交回 Harness。相比两个 coding-agent 的完整捕获，它没有复制大段工具说明和运行时环境，这是优点。

仍可继续审视三类内容：

1. **确定性事实规则**：例如价格库存来源、候选为空与无库存的区别，必须先确认 Harness/测试已经强制；prompt 可保留一句面向模型的语义提示，但不能成为唯一防线。
2. **重复输出契约**：若 structured output schema 已由 SDK 注入，prompt 里的完整 JSON 示例可能只需保留 action 的语义区别，避免双份 schema 漂移。
3. **流程例外堆积**：每增加一句规则，都应有一个行为 Eval 证明删掉它确实会导致错误；否则优先删或移到 Tool/Harness。

这与 Anthropic 官方对项目 instructions 的建议一致：只保留每次都需要、无法从代码推断且会改变行为的信息，并像维护代码一样测试和定期裁剪。参见 [Claude Code best practices](https://code.claude.com/docs/en/best-practices) 与 [How Claude remembers your project](https://code.claude.com/docs/en/memory)。OpenAI 也建议用 `AGENTS.md` 提供持久上下文、把任务 prompt 写成清楚的 issue，参见 [How OpenAI uses Codex](https://openai.com/business/guides-and-resources/how-openai-uses-codex/)。

## 建议的三层契约

### Prompt engineering

只回答五个问题：

1. Chatty 的目标是什么？
2. 哪些开放式判断由 Model 做？
3. 何时调用哪类 Tool，何时澄清或停止？
4. 什么内容不能声称，回答应采用什么表达边界？
5. final action 各自代表什么用户语义？

### Context engineering

每轮 Context 都应能回答：

1. 这块信息为何与当前 `ParsedRequest` 有关？
2. 来源是什么，何时获得，是否仍然有效？
3. Model 需要原始数据还是摘要字段？
4. 最大条数、字符数和历史轮数是多少？
5. 哪些信息只应进入 Harness Evidence，不应让 Model 看到？

### Harness engineering

Harness 负责可执行契约：

- `ParsedRequest` 生成与 schema 校验；
- Context 的选择、排序、裁剪和来源标注；
- Tool 白名单、执行、错误分类、重试与停止条件；
- SQLite 商品、价格和库存真值；
- 每轮 Evidence/Trace 隔离；
- final output schema 与事实复核；
- prompt、Context 和 Harness 三类变更各自对应的 Eval。

## 推荐的评估顺序

不要先重写 prompt。先建立三组基线，再用最小改动逐项比较：

1. **Prompt eval**：同一 Context 下，测 Tool 选择、澄清、停止和表达质量。
2. **Context eval**：同一 prompt/Harness 下，测召回率、噪声、token 预算、过期信息和冲突来源。
3. **Harness eval**：故意让 Model 输出错误商品、价格、库存或 action，确认确定性防线能拦截或修复。

三组结果分开，才能知道一次行为改善来自 prompt、Context 还是 Harness，而不是把所有变化都归因于 `instructions.md`。
