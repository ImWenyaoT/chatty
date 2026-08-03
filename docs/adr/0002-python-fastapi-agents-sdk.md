---
status: accepted
---

# 使用 Python、FastAPI 与 OpenAI Agents SDK

Chatty 使用 Python 后端与 TypeScript 前端。`backend/app/` 承担 Agent、Tool、Harness、
SQLite 和 FastAPI HTTP，`frontend/` 使用 React + Vite。

这套技术栈接近 FastAPI 官方全栈模板，也与 Luup 的目录习惯一致，但只保留 Chatty 需要的部分。
Chatty 仍然是 Single Agent，五项能力仍然是 Tool，SQLite 仍然是商品、库存和知识检索的运行时事实源。

## 模型与 Agent Loop

- 后端直接使用 OpenAI Agents SDK for Python 的 `Agent`、`Runner` 和 `function_tool`。
- 默认模型是 DeepSeek，通过 SDK 的 OpenAI-compatible provider 调用 Responses API。
- Agent SDK 负责标准 Agent Loop；Harness 仍负责工具依赖、事实证据、轮次上限和最终校验。
- Tool 结果继续分成两个 Context Out：`model` 进入下一轮模型上下文，`evidence` 只由 Harness 保有。

## 配置契约

密钥和模型配置可以来自已导出的系统环境变量、`.env.local` 或 `.env`。
加载优先级固定为：

```text
.env.local > .env > system environment
```

`DEEPSEEK_API_KEY` 是主变量；它缺失时才回退到 `OPENAI_API_KEY`。
代码和日志不输出密钥。

## 工程门禁

根目录的 pnpm scripts 是统一工程入口。`pnpm run check` 串起 Python 与 TypeScript 的格式、
静态检查、确定性测试和前端构建。需要真实模型和费用的评测不放进默认门禁。
