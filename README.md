# 🛒 Chatty

Chatty 是一个中文电商推荐 Single Agent。模型负责理解需求、调用 Tool 和撰写表达；
Harness 与 SQLite 负责价格、库存、知识依据和最终结果的可信性。

`Python` · `FastAPI` · `OpenAI Agents SDK` · `DeepSeek Responses API` · `SQLite FTS5` · `React`

## 启动

```bash
uv sync --project backend
pnpm install
cp .env.example .env.local
# 在 .env.local 中填写 DEEPSEEK_API_KEY
pnpm dev
```

打开 `http://localhost:5173`。`pnpm dev` 会同时启动中文 Web GUI 与 API。

配置优先级为 `.env.local > .env > 系统环境变量`。也支持 `OPENAI_API_KEY`、
`OPENAI_BASE_URL` 和 `MODEL_ID` 这些兼容变量；默认使用 DeepSeek。

## 文档

- [Chatty Book](docs/chatty-book/README.md)：从一次购物请求出发，逐章讲解 Agent、Harness、Tool、RAG、评估与画像更新。
- [架构决策](docs/adr/)：记录 Web GUI 与 Python/FastAPI 技术栈的选择。

## 验证

```bash
pnpm test             # 确定性测试，不联网
pnpm eval:retrieval   # FTS5 检索评测，不联网
pnpm eval:agent       # 真实 DeepSeek + Harness 端到端评估
pnpm run check        # lint、typecheck、test、build
```

## License

[MIT](LICENSE)
