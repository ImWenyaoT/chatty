# Domain Docs

工程工作开始前先完整读取根 `CONTEXT.md`。它是当前唯一的架构入口与领域词汇表；不要为 package、app、eval 或 retrieval 建立并行 `CONTEXT.md`。

涉及架构决策时继续读取 `docs/adr/`。ADR 保存重要决策史；以状态为 `Accepted` 且未被更新 ADR 取代的决定为当前约束。

输出中的领域概念使用根 `CONTEXT.md` 已定义的名称。项目最高公理 **Agent = Model + Harness** 优先；其下，Agent 运行与 API 术语遵循 OpenAI Developers，AI coding 术语遵循 Dictionary of AI Coding。

## Flag ADR conflicts

如果工作与 ADR 冲突，必须显式指出，不能静默覆盖：

> _Contradicts ADR-0007 (event-sourced orders) -- but worth reopening because..._
