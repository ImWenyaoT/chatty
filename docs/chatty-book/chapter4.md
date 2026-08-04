# 第 4 章：五个 Tool

Tool 属于 Harness。Chatty 有五项 Tool 能力：其中三个由 Harness 固定执行，两个通过
Agents SDK `function_tool` 开放给 Model。每个 Tool 只回答一个明确的问题。

| Tool                     | 要回答的问题               | 代码中的 Context Out                  |
| ------------------------ | -------------------------- | ------------------------------------- |
| `get_user_profile`       | 这个用户有什么历史偏好？   | `RecommendationContext.profile`       |
| `search_products`        | 哪些商品符合类目和价格？   | `RecommendationContext.candidates`    |
| `check_inventory`        | 候选商品现在是否有货？     | `RecommendationContext.inventory`     |
| `retrieve_knowledge`     | 当前问题需要什么知识依据？ | Model Tool Result + Harness Evidence  |
| `get_marketing_strategy` | 应该用什么语气表达？       | Model Tool Result + Harness Tool Trace |

商品搜索、库存检查和知识检索看起来都像“搜索”，但它们查询的是不同事实。

商品搜索从用户需求得到候选集合；库存检查确认候选是否可售；知识检索寻找能够支撑推荐理由的内容。商品目录变化、库存变化和知识文档变化的原因不同，把它们拆开后，每个 Tool 的输入和结果都更容易验证。

前三个 Tool 存在依赖顺序：

```text
get_user_profile → search_products → check_inventory
```

没有画像就无法确定完整搜索条件；没有候选商品也不知道应该检查哪些库存。因此 Harness
在调用 Model 前直接顺序执行这三个确定步骤。知识检索和营销策略分别依赖商品与画像，但
彼此没有先后依赖；当前本地 Tool 执行并发上限仍设为 1，避免批次状态发生竞态。

Model 始终只看到稳定的两个开放 Tool Schema，以便复用请求前缀。知识 Tool 用 `general` 与
`product` 两个 scope 区分通用问答和商品依据；纯知识请求只要求前者，混合请求两者都需要。
Harness 已确定的画像、
候选和库存通过 `RecommendationContext` 进入 Context，而不是再次暴露成三个必调 Schema。
同批重复调用会得到结构化的 blocked Tool Result，让 Model 在下一轮自行纠正。

Model 提出的参数并不会直接成为业务事实。Harness 会用用户本轮明确的类目和预算收窄搜索条件。
库存商品 ID、知识检索商品 ID 和营销用户分群直接从 Harness Evidence 派生，不要求 Model
重复传入。当前输入适配器没有提取标签，所以 Model 也不能凭空增加标签作为硬筛选条件。

如果商品搜索返回空数组，库存 Tool 仍会接收空数组。这一步看似没有查询内容，却形成了明确证据：当前条件下没有候选商品可以继续检查。完成其余 Tool 后，Agent 才能向用户提出放宽预算的澄清问题。

Model 可以根据初次检索结果改写 Query，再次调用知识 Tool；每轮最多三次检索。同一批重复
调用仍会被拒绝，防止并行调用读取不一致的 Evidence。

---

[← 上一章：用户画像与知识检索](chapter3.md) · [返回目录](README.md) · [下一章：用代码守住事实 →](chapter5.md)
