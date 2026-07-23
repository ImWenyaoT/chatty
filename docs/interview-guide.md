# Chatty 面试指南

本文档包含简历项目经验、STAR 话术、20 道面试题、常见追问和准备清单。

## 一、简历项目经验（直接复制）

```text
Chatty 单 Agent 电商推荐与营销系统 | 个人项目

• 基于 OpenAI Agents SDK 实现单 Agent 推荐流程，自主调用用户画像、
  商品搜索、库存校验、知识检索和营销策略 5 个 Function Tool
• 使用 SQLite 管理商品、用户画像和库存数据，基于 FTS5 + BM25
  实现轻量 RAG，为推荐理由和营销文案提供知识依据
• 使用 Pydantic 和应用层白名单校验模型输出，拒绝未知商品、
  过滤缺货商品，并从可信目录重新填充价格和库存
• 实现稳定 A/B 分桶、进程内指标与 FastAPI API，使用自动化测试
  覆盖数据、Tool、Agent 和 HTTP 层

技术栈：Python · OpenAI Agents SDK · DeepSeek · FastAPI · SQLite FTS5
```

## 二、STAR 法面试话术

### 完整版（3 分钟）

**S：背景**

> 我想做一个能放进简历的 AI Agent 项目。电商推荐适合展示 Tool Calling，因为结果依赖用户、商品、库存和知识数据。

**T：任务**

> 我的目标是用一个 Agent 完成完整推荐流程，同时避免为了展示技术而引入多个 Agent、Redis、向量数据库和前端。

**A：行动**

> 我使用 OpenAI Agents SDK 构建一个 Agent，并提供五个 Tool。业务数据存入 SQLite，知识检索使用 FTS5 和 BM25。DeepSeek 负责生成理由与文案，应用层使用 Pydantic 和 Catalog 校验商品 ID、库存、数量和禁词。推荐策略使用 SHA-256 稳定分桶，对比热度排序和个性化排序。

**R：结果**

> 项目可以通过 FastAPI 调用，也通过了自动化测试和真实 DeepSeek 冒烟。最终返回的商品、价格和库存都来自 SQLite，模型不能直接编造业务字段。

### 精简版（1 分钟）

> Chatty 是一个单 Agent 电商推荐 Demo。Agent 依次调用用户画像、商品搜索、库存、RAG 和营销策略五个 Tool，再让 DeepSeek 生成理由和文案。SQLite 保存业务数据和 FTS5 知识，Pydantic 与应用层白名单负责最终校验。

## 三、面试题 20 题

### Agent 基础（Q1 至 Q5）

**Q1：什么是 AI Agent？**

Agent 不只完成一次模型生成。它能根据当前状态选择 Tool、读取 Observation，并继续执行，直到完成目标。

**Q2：Chatty 为什么使用单 Agent？**

当前只有一个推荐目标和五个紧密相关的 Tool。它们共享用户、候选商品和库存上下文。

**Q3：Tool 和 Agent 有什么区别？**

Agent 由模型驱动，负责决策下一步动作。Tool 是确定性能力，例如查询 SQLite 或执行全文检索。

**Q4：什么时候应该升级为 Multi-Agent？**

当子任务需要独立上下文、独立权限、不同模型，或可以带来明确并行收益时再拆分。

**Q5：Chatty 是 ReAct 吗？**

它具有 Action 和 Observation 循环。项目不保存或展示模型的隐藏推理文本。

### 架构与数据（Q6 至 Q10）

**Q6：为什么选择 SQLite？**

Demo 数据量小，SQLite 同时支持关系表、事务和 FTS5，也不需要额外服务。

**Q7：JSONL 和 SQLite 分别做什么？**

JSON 和 JSONL 是可读的演示种子。运行时业务查询统一读取 SQLite。

**Q8：种子数据怎么保证完整？**

程序计算种子文件的 SHA-256 指纹，并检查关键表数量。不匹配时在一个事务中重新导入。

**Q9：为什么使用 Repository？**

Repository 隔离 SQL 和领域模型。Agent 与 Catalog 不需要了解表结构。

**Q10：为什么没有 Session 和 Memory？**

推荐接口是一次性结构化请求，不是聊天产品，因此不保存对话历史。

### RAG 与推荐（Q11 至 Q15）

**Q11：Chatty 的 RAG 怎么实现？**

知识写入 SQLite FTS5。Tool 执行全文检索和 BM25 排序，把 Top-K 文档返回 Agent。

**Q12：FTS5 RAG 和向量 RAG 有什么区别？**

FTS5 依赖关键词匹配。向量 RAG 擅长语义近义匹配，但需要 embedding 和向量索引。

**Q13：推荐排序怎么做？**

对照组按热度排序。个性化组组合类目偏好、价格范围、近期行为和热度。

**Q14：怎么处理新用户？**

未知用户使用默认画像，再结合请求中的类目和价格偏好。没有偏好时按热度排序。

**Q15：库存和推荐怎么协同？**

Agent 调用库存 Tool，最终 Catalog 还会再次读取库存并过滤缺货商品。

### 工程化（Q16 至 Q20）

**Q16：怎么防止模型幻觉？**

模型只返回商品 ID、理由和文案。应用层拒绝未知 ID，并从 SQLite 填充价格和库存。

**Q17：为什么不用 SDK 的结构化 `output_type`？**

SDK 会把它转换为 `json_schema response_format`，DeepSeek V4 Pro 当前不接受该参数。Chatty 接收 JSON 文本，再由 Pydantic 校验。

**Q18：怎么测试 Agent？**

脚本模型固定产生五次 Tool 调用和最终消息，从而稳定验证完整流程。

**Q19：错误怎么返回？**

缺少 API Key 返回 503。模型或输出失败返回 502。请求校验失败返回 422。

**Q20：A/B 测试怎么保证分组稳定？**

系统对 `user_id + experiment_id` 计算 SHA-256，再按奇偶分成两个 50% 组。

## 四、常见追问

### “这个项目上线了吗？”

> 这是本地 API Demo，没有声称生产上线。它真实实现并测试了 Agent Loop、SQLite、FTS5 RAG、库存校验和 FastAPI。

### “为什么不用 LangGraph？”

> 当前流程由一个 Agent 和五个 Tool 完成，没有状态图、并行分支或人工审批需求。

### “Token 成本怎么控制？”

> Tool 只返回候选商品和 Top-K 知识，不发送完整数据库。搜索、检索和 Agent 轮次都有上限。

### “并发量能到多少？”

> 项目没有压力测试，所以不提供 QPS 或 P99。生产化前需要压测、连接池、限流和缓存。

### “为什么不让模型直接查询数据库？”

> 固定 Tool 能限制查询范围和参数，也避免模型生成任意 SQL。

## 五、代码讲解要点

1. `src/chatty/agent.py`：Agent、Runner、DeepSeek 兼容和输出解析
2. `src/chatty/tools.py`：五个 Tool 与共享 RunContext
3. `src/chatty/catalog.py`：排序、库存过滤和可信字段回填
4. `src/chatty/retrieval.py`：FTS5 与 BM25

完整顺序见 [代码讲解指南](code-walkthrough.md)。

## 六、面试前准备清单

- [ ] 能画出一个 Agent 与五个 Tool
- [ ] 能解释为什么当前项目不需要 Multi-Agent
- [ ] 能说明 JSONL、SQLite 和 FTS5 的分工
- [ ] 能解释一次完整 RAG 流程
- [ ] 能说明模型输出后的业务校验
- [ ] 能解释 DeepSeek 的 `response_format` 兼容问题
- [ ] 能解释稳定实验分桶
- [ ] 能运行测试并调用推荐接口
- [ ] 不声称未经测量的 CTR、QPS 或 P99
- [ ] 能用 1 分钟介绍项目
