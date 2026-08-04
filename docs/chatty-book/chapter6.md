# 第 6 章：如何评估 Chatty

只测试某个函数是否返回预期值，还不足以说明一个 Agent 可以工作。Chatty 的评估需要覆盖
Model、包含 Tool Loop 的 Harness，以及 SQLite 组成的完整系统。

项目保留三层评估。

第一层是确定性测试：

```bash
pnpm test
```

它不调用网络模型，主要检查 Tool 调用顺序、Evidence、SQLite 查询、HTTP 边界和画像更新规则。这些测试速度快，适合每次改代码后运行。

第二层是知识检索评估：

```bash
pnpm eval:retrieval
```

十条标注 Query 会经过真实 FTS5 检索，程序计算 `recall@5` 和 MRR。它只回答“相关文档有没有被排在前面”，不评价完整 Agent。

第三层是端到端 Agent 评估：

```bash
pnpm eval:agent
```

它通过 `Chatty.run()` 调用真实 DeepSeek，让完整的 Task Framer、`Model + Harness` 处理
商品推荐、政策问答和混合请求。
每条任务都用代码检查：应该推荐、回答还是澄清，商品类目和预算是否正确、库存是否
大于零，以及最终字段是否与 SQLite 一致。评估直接复用 Agents SDK `RunResult` 汇总的
Model 请求数与 Token Usage，并记录覆盖需求解析与主 Agent 的端到端延迟；不另建 Trace
或 Eval 平台。政策用例还检查回答是否包含由知识文档确定的必要事实。

这些事实可以由程序直接判断，因此不需要再让另一个语言模型打分。任何价格、库存或商品 ID 错误都是硬失败，而不是“整体看起来还不错”。

评估的作用是形成一个短循环：观察失败用例，提出原因，只修改一个变量，然后重新执行同一组用例。小型合成数据不能代表真实电商业务效果，但可以防止 Chatty 在继续开发时破坏已经拥有的能力。
