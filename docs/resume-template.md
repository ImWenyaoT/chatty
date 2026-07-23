# Chatty 简历模板

以下内容只写当前代码和测试能够支撑的事实。请按自己的实际参与程度调整。

## 主模板

```text
Chatty 单 Agent 电商推荐与营销系统 | 个人项目

• 基于 OpenAI Agents SDK 实现单 Agent 推荐流程，自主调用用户画像、
  商品搜索、库存校验、知识检索和营销策略 5 个 Function Tool
• 使用 SQLite 管理商品、用户画像和库存数据，基于 FTS5 + BM25
  实现轻量 RAG，为推荐理由和营销文案提供知识依据
• 使用 Pydantic 与 Tool 证据集合、库存及检索范围校验约束模型输出，拒绝未知商品、
  过滤缺货商品，并从 SQLite 回填价格、库存和标签
• 实现 SHA-256 稳定 A/B 分桶、进程内指标与 FastAPI 推荐接口，
  使用自动化测试覆盖数据、Tool、Agent Loop 和 HTTP 错误映射

技术栈：Python · OpenAI Agents SDK · FastAPI · SQLite FTS5 · Pydantic · uv · Ruff · ty
```

## 按岗位替换一条

### Python 后端工程师

> 使用 SQLite schema、种子指纹和事务初始化演示数据，通过 FastAPI 与
> Pydantic 建立请求校验、错误映射和可信字段回填。

### 推荐或搜索方向

> 使用 SQLite FTS5 MATCH 与 BM25 返回 Top-K 知识，并通过稳定实验分桶
> 对比热度排序和轻量个性化排序。
