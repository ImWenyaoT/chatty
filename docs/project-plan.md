# Chatty 单 Agent 电商推荐与营销系统方案

本文档记录项目定位、技术选型、已实现功能和交付结果。

## 一、项目定位

Chatty 是面向学习和求职的单 Agent 电商 Demo。它用较少组件展示 Agent、Tool Calling、RAG、业务校验和 Web API 的完整链路。

### 1.1 项目目标

- 一个命令启动本地服务
- 一个接口展示完整 Agent Loop
- 所有业务数据都能找到来源
- 面试时可以解释每个核心模块
- 不依赖 Redis、Milvus、MySQL 或前端

### 1.2 设计原则

- 默认使用一个 Agent
- 模型负责语言生成，应用负责业务事实
- JSON/JSONL 负责初始化，SQLite 负责运行时查询
- 不编造业务收益和性能指标

## 二、系统设计

```text
用户请求
  → 用户画像
  → 商品搜索
  → 库存检查
  → 知识检索
  → 营销策略
  → DeepSeek 生成理由和文案
  → Pydantic 与 Catalog 校验
  → 推荐响应
```

### 2.1 五个 Tool

| Tool | 输出 |
|---|---|
| `get_user_profile` | 合并后的用户画像 |
| `search_products` | 候选商品 |
| `check_inventory` | 有货商品与低库存提示 |
| `retrieve_knowledge` | Top-K 知识文档 |
| `get_marketing_strategy` | 营销语气和禁词 |

## 三、Python 实现方案

- **框架**：OpenAI Agents SDK
- **LLM**：DeepSeek V4 Pro，通过 OpenAI-compatible Chat Completions API 调用
- **存储**：SQLite 业务数据 + SQLite FTS5 轻量 RAG
- **Web**：FastAPI
- **工程工具**：uv、Ruff、ty、pytest

### 3.1 核心文件结构

```text
src/chatty/
├── agent.py          # Agent、Runner 和模型客户端
├── tools.py          # 五个 Function Tool
├── models.py         # Pydantic 数据模型
├── catalog.py        # 搜索、排序和结果校验
├── database.py       # SQLite schema 与连接
├── seed.py           # 演示数据初始化
├── repositories.py   # 业务查询
├── retrieval.py      # FTS5 + BM25
├── experiments.py    # A/B 分桶与指标
└── app.py            # FastAPI
```

## 四、已实现功能

- [x] 单 Agent 推荐流程
- [x] 五个 Function Tool
- [x] DeepSeek Chat Completions
- [x] SQLite 业务数据和 FTS5 RAG
- [x] Pydantic 请求与输出校验
- [x] 缺货过滤和业务字段回填
- [x] 稳定 A/B 分桶与内存指标
- [x] FastAPI 与 OpenAPI 文档
- [x] Ruff、ty、pytest 和 GitHub Actions
- [x] 真实 DeepSeek 端到端冒烟

## 五、Demo 边界

当前不实现 Multi-Agent、Java/Go、Redis、Milvus、MySQL、向量检索、订单支付、前端或生产监控。

## 六、配套材料

| 文件 | 用途 |
|---|---|
| `README.md` | 项目首页和运行说明 |
| `docs/architecture.md` | 架构讲解 |
| `docs/code-walkthrough.md` | 代码讲解 |
| `docs/interview-guide.md` | 面试话术与问题 |
| `docs/resume-template.md` | 简历模板 |

## 七、验收结果

- 27 个自动化测试通过
- Ruff、ty 和 `uv lock --check` 通过
- 真实 DeepSeek 请求成功返回 3 个有库存商品

测试数量会随代码演进变化。简历中只写自己实际运行过的结果。
