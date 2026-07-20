<p align="center"><strong>Chatty</strong></p>
<p align="center"><a href="README.en.md">English</a></p>

Chatty 是一个用于简历展示的客服 Agent MVP。项目最高公理是 **Agent = Model + Harness**：Model 理解客户意图并选择 Tool；Harness 提供可信 Context、有界 Tools、真实执行、SQLite 持久化、Trace 与完成验证。OpenAI Agents SDK 负责唯一的 Agent Loop。

当前可运行路径是 `Next.js → FastAPI → Runner.run → SQLite`。Model 可查询带来源的卖家知识、读取与修改订单、保存带 Trace 来源的显式客户 Memory，或创建可追踪 Handoff。Harness 不以关键词预判意图，也不把一段回复当作业务完成证据。

## 运行

需要 Python 3.12、Node.js 24、uv 和 pnpm。

```bash
cp .env.example .env
uv sync --locked
uv run --env-file .env python main.py
```

另开终端：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

如需为本地演示补充可重复的订单、客户 Memory 与 Handoff receipt，可运行：

```bash
UV_CACHE_DIR=.cache/uv uv run python -m chatty.demo_data
```

重复执行不会重复生成同一批模拟数据；Agent Trace 仍只由真实 Agent Run 产生。

配置只有 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL_ID`。示例使用 DeepSeek 的 OpenAI-compatible Chat Completions API 和 `deepseek-v4-pro`；thinking 已关闭。缺少 key 时 Run API 返回明确错误。

## 三个页面

- `http://127.0.0.1:3000/playground`：发送消息并查看回复、来源与完成证据。
- `http://127.0.0.1:3000/dashboard`：查看真实 Agent Run、Tool、Trace 和结果。
- `http://127.0.0.1:3000/orders`：读取 Agent 操作后的 SQLite 订单。

三个页面只调用 FastAPI；浏览器请求先访问同源 `/api/chatty`，再由 Next.js rewrite 转发到本地 FastAPI。业务事实来自 `data/chatty.sqlite`，不是前端 fixtures。知识输入位于 `knowledge/records.jsonl`，导入 SQLite FTS5 后由 Agent Tool 搜索。Session、订单、Memory、Handoff receipt 与本地 Trace 也存入同一 SQLite 文件；`GET /sessions/{session_id}/messages` 可读取已绑定客户的 Session 历史。

## eval 与验证

确定性 eval 的用例是 `eval/cases.jsonl`。可控 Model 只替代外部 API；FastAPI、OpenAI Agents SDK Runner、Tool、SQLite、Trace 与完成验证均走真实 Agent path。

```bash
UV_CACHE_DIR=.cache/uv uv run python -m chatty.eval
UV_CACHE_DIR=.cache/uv uv run ruff format --check .
UV_CACHE_DIR=.cache/uv uv run ruff check .
UV_CACHE_DIR=.cache/uv uv run ty check
UV_CACHE_DIR=.cache/uv uv run pytest -q
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

`pnpm test:e2e` 会启动确定性 FastAPI 测试服务与 Next.js，并使用本机 Chrome 验证 Playground 发起 Agent Run、Harness 持久化 Trace、Dashboard 读取证据的真实浏览器路径。

有真实 DeepSeek 凭据时，显式运行 contract eval：

```bash
UV_CACHE_DIR=.cache/uv uv run pytest -q --run-deepseek tests/test_deepseek_contract.py
```

contract eval 不输出或持久化 secret。

## 项目边界

这是用于说明 Agent/Harness 边界、真实业务副作用和可验证结果的本地简历项目，不是生产客服或生产电商系统。认证、多租户、支付、仓储、远程部署、SLA、multi-agent、RAG/vector database 与 streaming 均不在 MVP 范围内。

详细领域语言与架构入口见 [`CONTEXT.md`](CONTEXT.md)，决策史见 [`docs/adr`](docs/adr)。

## 许可

[MIT](LICENSE)
