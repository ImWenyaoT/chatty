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
