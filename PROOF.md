# PROOF

这份文档回答一个问题：**Chatty 声称的每件事，怎么自己验一遍。**

每条都给可执行命令和预期输出。凡是有已知不确定性的地方，这里给出实测区间而不是一个漂亮数字。

## 0. 前置

```bash
pnpm install
```

Node 24 起步（`node:sqlite` 与原生类型剥离都依赖它）。只有第 4 节需要模型 API key，其余全部离线可跑。

## 1. 一条命令跑完所有确定性门禁

```bash
pnpm run check
```

等价于 CI——`.github/workflows/ci.yml` 只跑这一条。本地绿即 CI 绿。它串起 oxlint、prettier、
tsc、30 个单元测试和前端构建。

实测：

```
ℹ tests 30
ℹ suites 9
ℹ pass 30
ℹ fail 0
ℹ duration_ms 257
```

## 2. 「价格与库存不由模型生成」怎么验

这是 Chatty 最硬的一条主张。它由三层保证，每层都可单独验证。

**第一层：模型看不到最终价格。** 模型只输出 `product_id` 和理由文案，价格与库存由
`Catalog.finalize()` 在校验通过后从 SQLite 重新查一遍。

**第二层：Evidence 集合校验。** 模型推荐的每个 `product_id` 都必须同时出现在 Harness 自己
记录的三个集合里——召回过、库存检查过、有知识支撑。任一不满足即整轮拒绝。

```bash
node --test tests/agent.test.ts
```

看 `草稿收敛` 这一组：它构造「模型推荐了未召回商品」等情形，断言 Harness 抛出
`product_not_recalled` / `inventory_not_checked` / `product_not_grounded`。

**第三层：状态栏不泄露 Evidence。** `renderAgentStatus()` 只投影进度与契约，不含商品 ID
和画像详情，模型无法反向篡改 Harness 的判断依据。见 `agent/lib/workflow.ts` 的注释与
golden 基线中的 `workflow_state` 用例。

## 3. 跨版本行为不漂移：golden 基线

```bash
node --test tests/golden.test.ts
```

`tests/fixtures/golden/data-layer.cases.json` 冻结输入，`data-layer.expected.json` 冻结输出，
覆盖中文分词、知识切块、TaskFrame 解析、门禁裁决与状态栏渲染。任何一处输出变化都会红。

## 4. 检索质量

```bash
pnpm eval:retrieval
```

离线、不调模型。实测：

```json
{ "hit_rate_at_5": 1, "mrr_at_5": 0.8083 }
```

## 5. 端到端行为评测——以及它的已知方差

```bash
pnpm eval:agent    # 需要 API key
```

7 个 case 覆盖澄清、推荐、画像覆盖、售罄替代、知识问答、混合请求。

**这一条不稳定，且方差大于任何单次改动的效果。** 同一份代码（commit `e3340c3`）连跑三次：

| 运行 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| pass_rate | 0.857 | 0.571 | 0.714 |

7 个 case 里只有 2 个稳定通过（「200 元耳机没有可售候选」「配送政策问答」），其余 5 个存在
运行间抖动。失败集在不同运行之间会整体换一批，pass_rate 却可能持平。

失败几乎都落在 `invalid_draft`——DeepSeek 未遵守 structured output，或草稿未通过
`finalizeReply` 的业务规则校验。兜底机制是 `draft_corrector` 一次受限改写；改写仍失败则整轮
返回稳定错误码，**不会把没有事实支撑的内容返回给用户**。

**因此：单次 `eval:agent` 结果不作为改动是否有效的判据。** 任何声称提升通过率的改动，都需要
多次运行的分布对比；零语义变更的重构（如把提示词搬进 Markdown）则改用确定性断言验证，见下节。

## 5.1 失败归因：从一个错误码到六个

上一节说「失败几乎都落在 `invalid_draft`」——这句话本身就是问题。`invalid_draft` 此前被抛在
六个语义完全不同的位置，共用一个错误码，`diagnostics` 一律传空对象。看到 `invalid_draft`
只能知道草稿没过，不知道没过哪一关。

PR #74 给这六处各补一个 `reason`，能拿到模型选择时一并带上 `draft_action`。抛出条件、错误码、
返回给用户的文案都没动，零行为变更。

```bash
grep -n "invalid_draft" agent/lib/executor.ts   # 六处
```

| reason | 含义 |
| --- | --- |
| `correction_agent_failed` | `draft_corrector` 改写后仍不符合 schema |
| `final_output_missing` | run 结束但没有 `finalOutput` |
| `answer_action_not_allowed` | 选了 answer，但没有知识问题 / 存在商品需求 / answer 为空 |
| `clarify_not_allowed` | 选了 clarify，但没有商品需求或 question 为空 |
| `recommend_not_allowed` | 选了 recommend，但没有商品需求或 recommendations 为空 |
| `knowledge_answer_missing` | 有知识问题，但 answer 留空 |

在 commit `9c34fb7`（含诊断，已在 main）上连跑 5 轮 `pnpm eval:agent`，逐 case 结果：

| case | 通过 / 5 |
| --- | --- |
| 200 元耳机没有可售候选 | 5/5 |
| 300 元耳机可以推荐 | 5/5 |
| 本轮手机需求覆盖历史画像 | 5/5 |
| 有可售替代时不会推荐售罄商品 | 4/5 |
| 价格敏感用户可以买配件 | 3/5 |
| 配送政策问答 | 4/5 |
| 商品推荐与退货政策混合请求 | 3/5 |

五轮 pass_rate 依次为 0.857 / 1.000 / 1.000 / 0.714 / 0.571，平均 0.829。

6 次失败的归因分布：

- `answer_action_not_allowed` 4 次——「价格敏感用户可以买配件」2 次，「有可售替代时不会推荐
  售罄商品」1 次，「商品推荐与退货政策混合请求」1 次
- `recommendation_failed` 1 次
- 1 次未捕获到 reason

**结论：`answer_action_not_allowed` 占全部失败的三分之二，且横跨三个不同 case。** 它不是某个
case 的偶发抖动，而是一个系统性失败模式——存在商品需求时，模型仍倾向输出 `action: "answer"`。
这个结论在补 `reason` 之前拿不到，因为六种失败共用一个错误码。

方法论：先分类，再计数。错误码的粒度决定了能不能归因；无法归因的失败，再多次运行也只是噪声。

## 5.2 从软约束升级到硬约束

5.1 定位到 `answer_action_not_allowed` 是系统性失败后，按两步验证了两种修法。全部数据均为
每种变体 5 轮 `eval:agent` 实测。

**第一步：软约束（提示词说明 + 状态栏结论行）。**
在 `agent/instructions.md` 里解释 `allowed_final_action` 是什么、不含 `answer` 时该怎么办；
状态栏在读数旁边补一行已算好的结论 `final_action_check`。

**第二步：硬约束（收窄输出契约）。**
`buildAgentDraftSchema(actions)` 按本轮请求类型收窄 `action` 的 enum。存在商品需求时
outputType 里没有 `answer` 这个取值，模型在解码阶段就发不出来。`draft_corrector` 使用同一份
收窄 schema——否则纠正会把主 Agent 发不出的 action 重新放回来。

结果：

| | 基线 | + 软约束 | + 硬约束 |
| --- | --- | --- | --- |
| 平均 pass_rate | 0.829 | 0.829 | 0.914 |
| `answer_action_not_allowed` 次数 | 4 | 3 | **0** |
| 「商品推荐与退货政策混合请求」 | 3/5 | 2/5 | 5/5 |

**软约束没有可测量的效果**：平均 pass_rate 完全持平，失败总数同为 6，两个 case 涨、两个 case 跌。
它保留在代码里是因为它解释了字段语义（也面向人类读者），但不能声称它降低了失败率。

**硬约束消除了整类失败。** 注意这里 `answer_action_not_allowed` 归零不是统计结论，而是**结构保证**：
模型的 outputType 里不存在这个取值，5 轮实测只是确认没有遗漏的路径（例如纠正 Agent）。
对应的确定性证明见：

```bash
node --test tests/agent.test.ts   # 「输出契约收窄」两条
```

同一份 `action: "answer"` 的草稿，在收窄 schema 下 `safeParse` 失败、在全量 schema 下成功；
并验证收窄没有绕过既有的 `superRefine` 跨字段规则。

pass_rate 0.829 → 0.914 仍是小样本（n=5），不作为独立结论使用；可依赖的是那个归零。

## 6. 重构不改变模型看到的内容

提示词从 TypeScript 字符串搬进 Markdown 时，正确性用逐字节相等证明，而不是跑模型：

```bash
node --test tests/agent.test.ts
```

- `系统提示词逐字节来自 agent/instructions.md` — 主 Agent 实际使用的 instructions 必须等于
  文件内容。读取器不做 `trim()`，否则这条断言就成了谎话。
- `draft_corrector 逐字节来自 instructions.md`
- `task_framer 只替换 {{categories}}，其余逐字节保留`
- `subagent 提示词保持单行、无末尾换行` — 原提示词是 `+` 拼接、零换行；加换行是改 prompt，
  不是搬运。这条会在有人无意重排时变红。

## 7. 架构约束是可执行的，不只是文档

CONTEXT.md 里的两条主张各有一条测试钉住：

| 主张 | 测试 |
| --- | --- |
| Single Agent：Subagent 对主 Agent 不可见 | `主 Agent 的 Tool 里不含任何 subagent` |
| 路径决定身份：文件名是 Tool 名的唯一真相 | `Tool 名与 agent/tools/ 的文件名一一对应` |

后者同时断言**没有任何 Tool 文件自己写 `name:`**。

## 8. 规模

```
源码           5163 行（agent / data / server / web / evals / tests）
商品            43 条
知识文档        54 条
用户画像         5 个
模型可见 Tool    2 个（另有 3 个 Harness 确定性步骤）
```

## 已知边界

- `eval:agent` 的抖动见第 5 节。这是当前最大的未解问题，也是所有后续改动的验证瓶颈。
- 会话状态存服务端内存，进程重启即丢失。演示项目的有意选择，见 AGENTS.md 的 Project boundaries。
- SQLite 使用 `:memory:`，每次启动从 `data/seed/` 重建。没有写路径，也就没有持久化需求。
