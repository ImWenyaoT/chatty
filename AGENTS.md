## Domain docs

工程工作开始前先读取根 `CONTEXT.md`。它是当前唯一的领域词汇入口。

## Vocabulary

- Chatty 是一个 Single Agent。
- 用户画像、商品搜索、库存检查、知识检索和营销策略都是 Tool，不是 Agent。
- RAG 指 `retrieve_knowledge` 执行检索、结果进入 Agent 上下文并参与生成的完整流程。
- SQLite 保存演示业务数据；SQLite FTS5 保存并检索知识文档。
- 技术名称和代码标识保留英文，其余说明优先使用简体中文。

## Project boundaries

- 不引入 Multi-Agent、Handoff、LangChain 或 LangGraph。
- 不增加前端、外部数据库或向量数据库。
- 商品价格和库存必须来自 SQLite，不能由模型生成。
- JSON/JSONL 是 SQLite 的初始化种子，不是运行时业务查询接口。

## Verification

提交前运行：

```bash
uv run ruff check .
uv run ty check
uv run pytest -q
```
