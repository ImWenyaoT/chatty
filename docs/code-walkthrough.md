# Chatty 代码讲解指南

本文档按一次推荐请求的执行顺序讲解核心文件，帮助你现场解释代码。

## 1. `models.py`：数据契约

**面试考点**：Pydantic、输入约束、结构化输出。

`RecommendationRequest` 定义用户、场景、数量和上下文。所有模型继承 `StrictModel`，未知字段会被拒绝。

```python
class RecommendationRequest(StrictModel):
    user_id: str = Field(min_length=1, max_length=64)
    scene: Scene = "homepage"
    num_items: int = Field(default=5, ge=1, le=10)
    context: UserContext = Field(default_factory=UserContext)
```

**面试怎么说**：请求、种子、Tool 参数和模型输出共用 Pydantic，错误会在进入业务逻辑前暴露。

## 2. `config.py`：环境配置

`python-dotenv` 从仓库根目录加载 `.env`。`override=False` 保证进程环境变量优先。

```python
def load_root_env() -> None:
    load_dotenv(ROOT / ".env", override=False)
```

## 3. `database.py` 与 `seed.py`：SQLite 初始化

首次启动会创建业务表、FTS5 虚拟表和种子元数据。`seed.py` 计算数据文件指纹；数据变化或表不完整时，事务会重新导入演示数据。

这套设计避免“数据库存在，但只导入了一半”的静默失败。

## 4. `repositories.py`：业务查询

Repository 把 SQLite 行转换成 Pydantic 模型。Agent 不直接执行 SQL，也不能修改商品价格和库存。

## 5. `retrieval.py`：轻量 RAG

检索器对查询词执行 FTS5 `MATCH`，使用 BM25 排序，并按类目和商品 ID 过滤结果。

```python
rows = self.database.execute(sql, parameters).fetchall()
return [
    KnowledgeHit(
        **self._document_fields(row),
        relevance_score=self._score(row["rank"]),
    )
    for row in rows
]
```

**面试怎么说**：这是完整 RAG，不是向量 RAG。数据量小时，FTS5 能减少外部依赖。

## 6. `catalog.py`：搜索与业务校验

Catalog 负责两件事：

1. 根据实验组对候选商品排序
2. 对模型草稿做最终业务校验

最终响应中的名称、价格、库存和标签全部来自 SQLite。

## 7. `tools.py`：五个 Function Tool

`RecommendationContext` 保存当前请求、Catalog、实验组、已调用 Tool，以及召回、库存和知识证据。五个 Tool 共享这份上下文。

```python
async def get_user_profile(
    ctx: RunContextWrapper[RecommendationContext],
) -> str:
    context = ctx.context
    profile = context.catalog.user_profile(
        context.request.user_id,
        context.request.context,
    )
    context.profile = profile
    context.used_tools.add("get_user_profile")
    return profile.model_dump_json()

return [
    function_tool(
        get_user_profile,
        name_override="get_user_profile",
    )
]
```

Tool 的业务调用、证据记录和 JSON 序列化集中在同一个实现中，不保留只做转发的 payload helper。

## 8. `agent.py`：Agent Loop

`RecommendationService` 创建一个 Agent，并通过 `Runner.run` 执行最多 10 轮。

```python
agent = Agent[RecommendationContext](
    name="Chatty",
    instructions=AGENT_INSTRUCTIONS,
    model=model,
    tools=build_tools(),
)
result = await Runner.run(
    agent,
    request.model_dump_json(),
    context=context,
    max_turns=10,
)
```

DeepSeek V4 Pro 不接受 SDK 生成的 `json_schema response_format`。代码接收文本结果，提取 JSON，再交给 Pydantic 校验。

最终商品必须同时出现在召回集合、库存检查集合和知识检索关联集合中，否则请求明确失败。

## 9. `experiments.py`：稳定分桶

系统对 `user_id + experiment_id` 计算 SHA-256，再按奇偶分成两个 50% 组。服务端重新计算分组，客户端不能伪造实验组。

## 10. `app.py`：HTTP API

应用提供推荐、健康检查、实验结果和指标接口。`RecommendationFailure` 在 HTTP 层映射为 502 或 503。

## 11. 测试设计

- 数据测试：20 个唯一商品、5 类画像、种子修复
- Tool 测试：搜索、库存、RAG、营销策略
- Agent 测试：脚本模型固定五次 Tool 调用
- API 测试：请求校验、错误码、实验和指标

真实 DeepSeek 冒烟不放进 CI，避免消耗密钥和额度。
