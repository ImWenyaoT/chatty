# 第 10 章：为什么 Chatty 只有一个 Agent

Chatty 有五个 Tool，但只有一个 Agent。这里始终采用同一个概念层级：

```text
Agent = Model + Harness
Harness 管理 Context、Tool、Agent Loop、Control 与 Evidence
```

Tool 和 Agent 的区别也不在于名字，而在于它是否拥有独立目标和决策循环。

商品搜索 Tool 接收查询参数并返回候选商品；库存 Tool 接收商品 ID 并返回库存。它们不会自行规划下一步，也不会与其他 Tool 协商，因此不是 Agent。

完整推荐链路共享同一份用户需求、画像、商品候选和 Evidence。一个 Model 在同一个 Tool Loop 中就能获得全部信息，再由 Harness 统一验证。把画像、商品、库存、知识和营销分别做成 Agent，只会增加 Context 传递、错误定位和最终校验的成本。

```text
一个 Chatty Agent
  ├── Model
  └── Harness
      ├→ get_user_profile
      ├→ search_products
      ├→ check_inventory
      ├→ retrieve_knowledge
      └→ get_marketing_strategy
```

多 Agent 的价值通常来自真实的信息隔离、不同权限、外部反馈或可以并行完成的独立任务。Chatty 当前没有这些条件，所以 Single Agent 是更直接的实现。

这也让系统边界更清楚：Agent 内部由 Model 完成开放式判断，Harness 提供 Tool、负责
整个循环和事实裁决。未来只有当新任务无法在同一个 Context 和验证边界内完成时，才需要
重新考虑多个 Agent。

[← 上一章：中文 Web GUI](chapter9.md) · [返回目录](README.md)
