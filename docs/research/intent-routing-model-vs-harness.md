# Intent routing：Model 与 Harness 的职责边界

## 结论

Claude Code、`learn-claude-code` 的最小循环和 OpenAI Agents SDK 的默认运行方式都不是：

```text
Harness 用正则预先识别业务意图 → 选择固定流程 → Model 只负责润色
```

而是：

```text
用户输入 + instructions + 可用工具
                ↓
        Model 理解意图并决定动作
                ↓
Harness 校验、授权、执行工具并回传真实结果
                ↓
        Model 根据结果继续或结束
```

因此，对 Chatty 单 Agent MVP，默认边界应该是：

- **Model**：理解用户问题、形成当前任务判断、决定是否需要工具、选择工具及参数、读取工具结果后继续推理，并决定何时给出最终答复。
- **Harness**：定义可用能力和工具 schema，注入业务上下文，校验参数与权限，执行真实业务操作，保存/回传工具结果，限制轮数，并用确定性业务规则验证任务是否真正完成。
- **不应默认存在**：在 Model 运行前用关键词/正则把每条自然语言请求分类成某个业务意图，再据此替 Model 选择路径。规则可以做安全与业务不变量校验，但不应冒充语义理解。

一句话：**Model 负责选择行动；Harness 负责规定什么行动存在、什么行动允许执行、执行后什么才算成功。**

## 1. `learn-claude-code`：没有前置意图分类器

在 s01 中，Harness 只做三件核心事情：

1. 把用户消息、system prompt 和工具定义一起交给 Model；
2. 执行 Model 返回的 `tool_use`；
3. 把 `tool_result` 喂回 Model，直到 Model 不再调用工具。

工具调用由 Model 产生。代码没有在调用 Model 前解析用户输入，也没有按关键词选择“任务类型”。`TOOLS` 只是 Harness 提供给 Model 的行动空间；`stop_reason` 只控制循环是否继续。

来源：

- [`s01_agent_loop/code.py` 第 54–65 行：system prompt 与工具定义](https://github.com/shareAI-lab/learn-claude-code/blob/a9cafe953aa714f9cb1171f217d96bd2734bbcc7/s01_agent_loop/code.py#L54-L65)
- [`s01_agent_loop/code.py` 第 84–113 行：Model 调用、工具执行与结果回灌](https://github.com/shareAI-lab/learn-claude-code/blob/a9cafe953aa714f9cb1171f217d96bd2734bbcc7/s01_agent_loop/code.py#L84-L113)

s03 加入权限后，这个职责边界仍不变：Model 先选择工具，Harness 再对这次具体调用执行 deny list、规则检查和用户批准，然后才运行 handler。权限规则约束的是“是否允许执行 Model 已选择的动作”，不是替 Model 识别用户意图。

来源：

- [`s03_permission/code.py` 第 125–195 行：工具池与三道权限门](https://github.com/shareAI-lab/learn-claude-code/blob/a9cafe953aa714f9cb1171f217d96bd2734bbcc7/s03_permission/code.py#L125-L195)
- [`s03_permission/code.py` 第 202–231 行：Model 先产生 tool call，Harness 后校验和执行](https://github.com/shareAI-lab/learn-claude-code/blob/a9cafe953aa714f9cb1171f217d96bd2734bbcc7/s03_permission/code.py#L202-L231)

这也是教学版能用很少代码表达 Agent 核心的原因：自然语言到行动的映射没有被另写成一套规则引擎，而是由 Model 在 tool schema 与 instructions 所定义的边界内完成。

## 2. Claude Code：生产级保护更多，核心决策仍由 Model 完成

本地 Claude Code 源码的主查询路径将完整的 `messages`、`systemPrompt` 和 `toolUseContext.options.tools` 直接传给 Model，并明确把 `toolChoice` 设为 `undefined`。在这条核心路径上，Harness 没有先将用户请求分类为“读文件”“搜索”“编辑”等意图，再指定某个工具；Model 能看到工具集合并自己产生 `tool_use`。

来源（本地一手源码）：

- `/Users/edward/Documents/oss/claude-code/query.ts:659-675`：向 Model 传入消息、prompt、工具池，`toolChoice: undefined`
- `/Users/edward/Documents/oss/claude-code/query.ts:826-843`：从 Model 输出中收集 `tool_use`，并交给流式工具执行器
- `/Users/edward/Documents/oss/claude-code/query.ts:1062`：没有 `tool_use` 时进入完成/恢复分支
- `/Users/edward/Documents/oss/claude-code/query.ts:1380-1408`：执行 Model 产生的工具调用并收集结果

Claude Code 的 Harness 复杂度主要出现在执行边界，而非自然语言意图的前置规则路由：

- 工具参数先通过 schema 和工具自身的 `validateInput`；失败会作为 `tool_result` 返回，供 Model 修正。
- 工具执行前经过 hooks、`canUseTool` 和 permission decision；非 `allow` 不会执行。
- Harness 还负责工具并发、取消、上下文压缩、错误恢复、预算与轮数等生产级保护。

来源（本地一手源码）：

- `/Users/edward/Documents/oss/claude-code/services/tools/toolExecution.ts:664-732`：schema/输入验证失败被转成工具错误结果
- `/Users/edward/Documents/oss/claude-code/services/tools/toolExecution.ts:916-999`：权限判定发生在工具执行前，拒绝则停止该工具调用
- [Claude Code 官方 CLI 文档](https://code.claude.com/docs/en/cli-usage)：`--tools` 限制对 Model 可见的工具，`--allowedTools`/`--disallowedTools` 与 `--permission-mode` 控制执行许可和批准方式

需要区分：Claude Code 中确实存在命令解析、权限分类器、危险命令规则等确定性逻辑，但这些逻辑处理的是 CLI 语法、工具可见性或执行安全；它们不是对普通用户任务做业务语义分类后替代 Model 选择工具。

## 3. OpenAI Agents SDK：`Runner` 内置同一个 Agent loop

OpenAI Agents SDK 的 `Runner` 官方定义就是：

1. 调用当前 Agent 的 Model；
2. 检查 LLM 响应；
3. 若为工具调用，则执行工具、把结果加入上下文并再次调用 Model；若为最终输出，则结束；
4. 达到 `maxTurns` 时停止。

来源：[OpenAI Agents SDK — Running Agents / The agent loop](https://openai.github.io/openai-agents-js/guides/running-agents/#the-agent-loop)

SDK 的默认 `modelSettings.toolChoice` 是 `auto`，即由 LLM 决定是否调用工具；也可以选择 `required`、`none` 或强制某个具体工具。对普通 Chatty 请求，应保留 `auto`，而不是在 Harness 中先识别意图再强制具体工具。若业务契约要求某一轮必须产生工具证据，可以在窄边界使用 `required`，但它仍允许 Model 在可用工具中做选择。

来源：[OpenAI Agents SDK — Agents / Forcing tool use](https://openai.github.io/openai-agents-js/guides/agents/#forcing-tool-use)

SDK 还明确提供了 Harness 应承担的原语：

- `tools`：向 Model 暴露可以调用的能力；function tool 使用 JSON/Zod schema 包装真实函数。
- `context`：把数据库连接、用户元数据、feature flags 等依赖注入工具、guardrail 和 handoff，而不把这些对象交给 Model。
- `inputGuardrails` / `outputGuardrails` / tool guardrails：在工作流输入、最终输出和每次函数工具调用边界做校验或阻断。
- `maxTurns`：限制循环。
- `toolUseBehavior: 'run_llm_again'`（默认）：工具结果回到 Model，让它基于真实结果继续推理。

来源：

- [OpenAI Agents SDK — Agents / Agent with tools and Context](https://openai.github.io/openai-agents-js/guides/agents/)
- [OpenAI Agents SDK — Tools](https://openai.github.io/openai-agents-js/guides/tools/)
- [OpenAI Agents SDK — Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)
- [OpenAI Agents SDK — Running Agents / Run arguments](https://openai.github.io/openai-agents-js/guides/running-agents/#run-arguments)

## 4. 对 Chatty 最小实现的直接含义

Chatty 的“Task Scheduling”不应先实现为 Harness 正则分类器。对单 Agent MVP，更小且更符合三套参考实现的结构是：

```text
Agent instructions：说明客服目标、可解决任务、必须取得的证据、何时 handoff
Agent tools：库存查询、订单处理、退款、客户 memory、knowledge search、创建工单……
Runner：使用 Agents SDK 内置 loop，默认 toolChoice=auto
Tool/Harness：严格 schema、权限、幂等、原子业务更新、错误回传
Verifier：检查工具结果和业务状态是否满足该任务完成条件
```

这里的 Task Scheduling 是 **Model 在有边界的工具空间内做动态调度**，而不是 Harness 在 Model 之前猜意图。用户问“这件衣服还有货吗”时，最小闭环应是：

1. Model 根据 instructions 和工具描述判断需要库存证据；
2. Model 调用库存工具并填写商品标识；
3. Harness 校验参数、权限并查询真实库存；
4. SDK 把结果回灌给 Model；
5. Model 返回有证据的答复；
6. Harness/verifier 确认答复所依赖的库存查询确实成功。

Harness 可以保留或新增的规则应落在明确边界上：

- **工具可见性**：本次 Agent 能做哪些业务动作；
- **输入契约**：必填字段、类型、范围、资源是否存在；
- **授权与批准**：谁可以退款、改订单、扣库存，何时需要 human-in-the-loop；
- **业务不变量**：库存不能扣成负数、订单状态迁移合法、写操作幂等；
- **完成验证**：必须出现成功的业务工具结果或真实、可追踪的 handoff；
- **运行保护**：最大轮数、超时、取消、错误处理和 tracing。

规则不应承担的职责：用“库存/有货/缺货”等关键词提前决定用户意图并绕过 Model。若 Model 选错工具，应通过更清晰的 tool name/description、instructions、schema、工具错误回灌和 eval 改进，而不是持续扩张一套平行的自然语言规则路由器。

## 5. 最终判断

“Harness 提前识别意图，Model 就没参与感”这个担忧是成立的，而且不只是主观感受：它会把 Agent 的核心决策从 Model 移到规则代码，最终得到的是“规则工作流 + LLM 文案层”。

Claude Code 和 `learn-claude-code` 的共同做法是：**Model 看到任务和工具后选择下一步；Harness 不相信 Model 的动作天然正确，所以在执行前后进行严格控制。** OpenAI Agents SDK 已把这个循环及其常用边界原语实现好。Chatty 的最低充分实现应沿用这一结构，而不是另外维护一个前置正则意图路由系统。
