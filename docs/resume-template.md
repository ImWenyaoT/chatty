# Chatty 简历模板

本文档提供 AI Agent、Python 后端和大模型应用岗位的项目写法。请按自己的实际经历删改。

## 模板一：应届或初级工程师

```text
Chatty 单 Agent 电商推荐与营销系统 | 个人项目

• 基于 OpenAI Agents SDK 实现单 Agent 推荐流程，自主调用用户画像、
  商品搜索、库存校验、知识检索和营销策略 5 个 Function Tool
• 使用 SQLite 管理 20 个商品、5 类用户画像和库存数据，基于 FTS5
  与 BM25 实现轻量 RAG，为推荐理由和营销文案提供知识依据
• 使用 Pydantic 校验请求、种子数据、Tool 参数和模型输出，应用层
  拒绝未知商品、过滤缺货商品并重新填充价格和库存
• 实现 SHA-256 稳定 A/B 分桶、进程内指标和 FastAPI 推荐接口，
  使用自动化测试覆盖数据、Tool、Agent 和 API

技术栈：Python · OpenAI Agents SDK · DeepSeek · FastAPI · SQLite FTS5
```

## 模板二：Python 后端方向

```text
Chatty 单 Agent 电商推荐与营销系统 | 个人项目

• 设计 FastAPI + SQLite 本地 API，将 Agent 生成能力与商品、库存等
  确定性业务规则分层
• 使用 Repository 隔离 SQL 查询，通过数据指纹和事务保证演示种子
  完整导入，数据库缺表或部分损坏时自动修复
• 基于 SQLite FTS5 MATCH 与 BM25 排序实现知识检索，并通过稳定的
  Retriever 接口向 Agent 返回 Top-K 证据
• 建立错误映射和日志边界：缺少模型配置返回 503，模型或输出失败
  返回 502，不使用静默降级掩盖异常
```

## 模板三：大模型应用方向

```text
Chatty 单 Agent 电商推荐与营销系统 | 个人项目

• 使用 OpenAI Agents SDK 的 Agent、Runner 和 Function Tool 构建
  DeepSeek Chat Completions Agent Loop
• 设计五步工具调用约束，要求模型完成画像、搜索、库存、RAG 和
  营销策略查询后才能生成结果
• 针对 DeepSeek 不支持 json_schema response_format 的兼容问题，
  实现 JSON 代码块提取与 Pydantic 本地校验
• 通过商品白名单、库存复查、可信字段回填和广告禁词替换降低模型幻觉
```

## 简历注意事项

### 推荐做法

1. 写清楚 Agent 调用了哪些 Tool
2. 写清楚模型与业务代码的边界
3. 写自己真正运行过的测试和接口
4. 准备一段 1 分钟项目介绍
5. 保留 GitHub 地址和启动命令

### 常见错误

1. 不要把五个 Tool 写成五个 Agent
2. 不要写 Redis、Milvus、MySQL 或向量检索
3. 不要写未经测量的 CTR、QPS、P99 或可用性
4. 不要把 FTS5 描述成向量数据库
5. 不要在仓库或简历中暴露 API Key

### 可复现的性能写法

> 在 i7-14700KF 本机使用确定性模型完成 500 次全链路基准，吞吐 178.82 QPS，P99 6.236 ms；真实 DeepSeek 5 次端到端冒烟全部成功，中位延迟 17.247 s。

这句话必须保留“本机”“确定性模型”和“5 次样本”三个限定。完整口径见 [性能测量报告](benchmark.md)。

## 针对不同岗位调整

### AI Agent 工程师

重点讲 Agent Loop、Tool schema、上下文状态和输出校验。

### Python 后端工程师

重点讲 FastAPI、Pydantic、SQLite、Repository、事务和错误映射。

### 推荐系统工程师

重点讲候选搜索、排序信号、稳定实验分桶和当前 Demo 的算法边界。

### 大模型应用工程师

重点讲 DeepSeek Chat Completions、RAG、Prompt 约束和幻觉防护。
