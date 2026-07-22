# 🛒 Chatty — 单 Agent 电商推荐与营销系统

> **面向学习与求职的 AI Agent 项目** — 用一个 Agent、SQLite 和轻量 RAG 完成个性化商品推荐与营销文案。

Python 3.12 + OpenAI Agents SDK + DeepSeek V4 Pro + FastAPI + SQLite FTS5，20 个演示商品，5 个 function tool。

---

## 📖 目录

1. [这个项目是什么？](#-这个项目是什么)
2. [系统架构](#-系统架构)
3. [五大核心 Tool 详解](#-五大核心-tool-详解)
4. [技术栈](#-技术栈)
5. [轻量 RAG 怎么工作](#-轻量-rag-怎么工作)
6. [快速上手运行](#-快速上手运行)
7. [API 接口文档](#-api-接口文档)
8. [项目文件结构](#-项目文件结构)
9. [面试八股文精选](#-面试八股文精选)
10. [简历写法](#-简历写法)
11. [边界与非目标](#-边界与非目标)

---

## 🤔 这个项目是什么？

### 用一句话解释

> 让一个 AI Agent 查询用户和商品数据、检查库存、检索商品知识，再生成有依据的个性化推荐理由与营销文案。

### 它解决了什么问题？

| 痛点 | 常见做法 | Chatty 的做法 |
|---|---|---|
| 推荐结果与用户偏好脱节 | 所有人看到相同榜单 | 根据类目、价格和近期行为调整排序 |
| 推荐到缺货商品 | 模型直接根据商品文本回答 | 返回前校验 SQLite 库存，缺货商品直接过滤 |
| 推荐理由缺少依据 | 让模型凭常识自由发挥 | 用 FTS5 检索商品指南和场景知识 |
| 营销文案千篇一律 | 所有用户使用同一套话术 | 5 类用户画像对应 5 种营销语气 |
| Demo 架构过重 | 引入多个 Agent 和外部数据库 | 单 Agent + 5 个 Tool + 单文件 SQLite |

### 技术关键词

`Single Agent` · `Function Calling` · `Structured Output` · `RAG` · `SQLite FTS5` · `FastAPI` · `A/B Testing` · `DeepSeek`

---

## 🏗 系统架构

### 整体架构图

```
POST /api/v1/recommend
          │
          ▼
Chatty 单 Agent（OpenAI Agents SDK）
          │
          ├── get_user_profile       ─┐
          ├── search_products         │ SQLite 业务数据
          ├── check_inventory        ─┘
          ├── retrieve_knowledge     ── SQLite FTS5 知识检索
          └── get_marketing_strategy ── SQLite 营销规则
          │
          ▼
结构化推荐草稿
          │
          ▼
应用层校验：商品存在 · 库存大于 0 · 数量限制 · 禁词替换
          │
          ▼
商品 + 推荐理由 + 营销文案
```

### 为什么用单 Agent？

这个 Demo 只有一个目标：完成一次商品推荐。画像、商品、库存、知识和营销策略共享同一个请求上下文，没有必要在多个 Agent 之间传递状态。

| | 单 Agent | Multi-Agent |
|---|---|---|
| 上下文 | 一处维护 | 需要在 Agent 间同步 |
| 调试 | 一条 Runner 流程 | 需要定位编排与子 Agent |
| 适用场景 | 工具少、目标集中 | 领域隔离或并行收益明显 |
| 本项目 | ✅ 采用 | ❌ 不采用 |

---

## 🔧 五大核心 Tool 详解

### Tool 1：用户画像

**它做什么？**

从 SQLite 读取演示用户画像，并使用当前请求中的浏览、购买、类目和价格偏好覆盖默认值。

### Tool 2：商品搜索

**它做什么？**

从 20 个 SQLite 商品中按类目、价格和标签搜索候选商品。A/B 分组决定热度优先还是个性化优先。

### Tool 3：库存校验

**它做什么？**

重新查询 SQLite 库存，过滤缺货商品，并标记库存不超过 100 件的低库存商品。

### Tool 4：知识检索

**它做什么？**

使用 SQLite FTS5 检索商品选购指南、使用场景和营销知识。检索结果会作为 Tool 输出回到 Agent 上下文，支持推荐理由和营销文案生成。

### Tool 5：营销策略

**它做什么？**

根据新用户、活跃用户、高价值用户、价格敏感用户和流失风险用户五种分群，返回文案语气、写作要求和禁词。

---

## 🌐 技术栈

**框架**：OpenAI Agents SDK<br>
**LLM**：DeepSeek V4 Pro（通过 OpenAI-compatible Chat Completions API 调用）<br>
**存储**：SQLite（业务数据）+ SQLite FTS5（轻量 RAG 知识检索）<br>
**Web**：FastAPI<br>
**工程工具**：uv、ruff、ty、pytest

| 技术 | 锁定版本 | 用途 |
|---|---:|---|
| Python | 3.12+ | 唯一运行语言 |
| OpenAI Agents SDK | 0.18.3 | Agent Loop 与 Tool Calling |
| OpenAI Python SDK | 2.46.0 | 调用 OpenAI-compatible Chat Completions API |
| DeepSeek V4 Pro | `deepseek-v4-pro` | 推荐理由和营销文案生成 |
| FastAPI | 0.139.2 | HTTP 接口与 OpenAPI 文档 |
| Pydantic | 2.13.4 | 请求、数据、Tool 参数和结构化 Agent 输出校验 |
| python-dotenv | 1.2.2 | 从仓库根目录加载本地 `.env` 配置 |
| Uvicorn | 0.51.0 | ASGI 服务启动 |
| SQLite / FTS5 | Python 标准库 | 业务数据与知识全文检索 |
| httpx2 | 2.7.0 | FastAPI/Starlette API 测试客户端 |
| pytest / pytest-asyncio | 9.1.1 / 1.4.0 | 自动化测试 |
| ruff / ty | 0.15.22 / 0.0.62 | Lint、格式化和类型检查 |
| uv | 锁文件驱动 | 依赖与虚拟环境管理 |

DeepSeek V4 Pro 不使用 Agents SDK 的 `json_schema response_format`；模型通过普通
Chat Completions 返回 JSON 文本，应用层提取后再由 Pydantic 严格校验。

项目不依赖 LangChain、LangGraph、Redis、Milvus、MySQL 或浏览器前端。

---

## 🔎 轻量 RAG 怎么工作

```
用户场景与候选商品
        │
        ▼
retrieve_knowledge Tool
        │
        ▼
SQLite FTS5 MATCH + BM25 排序
        │
        ▼
Top-K 商品指南与营销知识
        │
        ▼
注入 Agent 当前运行上下文
        │
        ▼
生成推荐理由与营销文案
```

这是一个真实可运行的检索增强生成流程，但不是向量 RAG：

- 知识文档进入 `knowledge_documents` 和 `knowledge_documents_fts`。
- 查询通过 FTS5 `MATCH` 执行，结果使用 BM25 排序。
- Tool 返回标题、正文、商品 ID、来源和相关度。
- Agent 必须调用知识检索 Tool，最终业务字段仍由应用层校验。
- 当前数据量很小，因此不引入 embedding 模型和向量数据库。

---

## 🚀 快速上手运行

### 前置条件

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- 一个 OpenAI-compatible API Key

### 三步运行

```bash
cp .env.example .env
# 编辑 .env，填写 OPENAI_API_KEY
uv sync
uv run python main.py
```

首次启动会自动创建 `.local/chatty.db`，并从 `data/` 导入演示业务数据和知识文档。数据库文件不会提交到 Git。

打开 <http://127.0.0.1:8000/docs> 查看接口文档。

### 质量检查

```bash
uv run ruff check .
uv run ty check
uv run pytest -q
```

---

## 📡 API 接口文档

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 服务状态、模型、商品数和知识数 |
| `POST` | `/api/v1/recommend` | 生成个性化商品推荐 |
| `GET` | `/api/v1/experiments` | 查看分组和实验统计 |
| `POST` | `/api/v1/experiments/ranking_strategy/outcomes` | 记录实验结果 |
| `GET` | `/api/v1/metrics` | 查看进程内指标 |

### 推荐请求示例

```json
{
  "user_id": "user_active",
  "scene": "homepage",
  "num_items": 3,
  "context": {
    "recent_views": ["手机", "降噪"],
    "preferred_categories": ["手机", "耳机"],
    "min_price_cents": 50000,
    "max_price_cents": 800000
  }
}
```

指标与实验结果只保存在当前进程内，服务重启后会清空；商品和知识数据保存在本地 SQLite 中。

---

## 📁 项目文件结构

```
chatty/
├── data/
│   ├── products.jsonl              # 20 个商品种子
│   ├── user_profiles.jsonl         # 5 类演示用户
│   ├── marketing_templates.json    # 5 类营销语气
│   ├── forbidden_words.json        # 演示广告禁词
│   └── knowledge_documents.jsonl   # RAG 知识种子
├── src/chatty/
│   ├── agent.py                    # 单 Agent + Runner
│   ├── tools.py                    # 5 个 function tool
│   ├── database.py                 # SQLite schema 与连接
│   ├── seed.py                     # JSON/JSONL 数据初始化
│   ├── repositories.py             # 业务数据查询
│   ├── retrieval.py                # FTS5 检索与 BM25 排序
│   ├── catalog.py                  # 排序、检索入口与出站校验
│   ├── experiments.py              # 稳定分桶与内存指标
│   ├── models.py                   # Pydantic 数据模型
│   ├── app.py                      # FastAPI
│   └── config.py                   # 环境配置
├── tests/
├── main.py
└── pyproject.toml
```

---

## ❓ 面试八股文精选

### Q1：为什么用单 Agent，而不是 Multi-Agent？

当前任务只有一次推荐目标和五个紧密相关的 Tool。拆成多个 Agent 会增加上下文传递、编排和失败处理成本，却没有产生新的领域边界。

### Q2：这个项目的 RAG 是怎么实现的？

知识文档初始化到 SQLite FTS5。Agent 调用 `retrieve_knowledge`，后端执行全文检索和 BM25 排序，再把 Top-K 文档作为 Tool 输出返回模型，用于生成有依据的推荐理由和营销文案。

### Q3：为什么不用向量数据库？

当前只有 12 条演示知识，FTS5 已经能完成检索增强流程，而且没有外部服务。它不擅长语义近义匹配；数据量和需求增长后，可以将检索器替换为 embedding + 向量索引，而不改变 Agent Tool 契约。

### Q4：怎么防止模型推荐不存在的商品？

模型只提交商品 ID、理由和文案。应用层拒绝未知商品、过滤缺货商品，并从可信商品目录填充价格、库存和标签。

### Q5：Agent 输出不确定，怎么测试？

测试使用脚本模型确定性地产生五次 Tool 调用和最终结构化输出，同时使用临时 SQLite 数据库验证建表、种子导入、FTS5 召回和 API 错误映射。

---

## 📋 简历写法

> **Chatty｜单 Agent 电商推荐与营销系统**
> Python / OpenAI Agents SDK / DeepSeek V4 Pro / FastAPI / SQLite FTS5
>
> - 基于 OpenAI Agents SDK 实现单 Agent 推荐流程，自主调用用户画像、商品搜索、库存校验、知识检索和营销策略 5 个 function tool。
> - 使用 SQLite 管理 20 个商品、5 类用户画像与库存数据，并基于 FTS5 + BM25 实现轻量 RAG，为推荐理由和营销文案提供知识依据。
> - 设计模型输出后的业务校验，拒绝未知商品、过滤缺货商品，并从可信目录填充价格和库存，减少模型业务幻觉。
> - 实现 SHA-256 稳定 A/B 分桶、进程内指标统计与 FastAPI 推荐接口，使用脚本模型完成确定性 Agent 测试。

---

## 🚧 边界与非目标

这是本地 API Demo，明确不提供：

- Multi-Agent runtime、Supervisor 或 Agent handoff
- Java、Go、LangChain 或 LangGraph 实现
- Redis、Milvus、MySQL、embedding 或向量检索
- 真实协同过滤和模型训练
- 浏览器前端、用户登录或多租户
- 订单、支付、仓储和履约
- 持久化实验指标和生产监控
- 已测量的 P99、点击率提升或业务收益

商品价格、库存、用户行为和知识文档均为演示数据。FTS5 RAG 适合展示完整流程，不代表生产级语义检索效果。

---

## 🔗 参考资料

- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [multi-agent-ecommerce-system](https://github.com/bcefghj/multi-agent-ecommerce-system) — 业务场景与 README 结构参考

## 📄 License

[MIT](LICENSE)
