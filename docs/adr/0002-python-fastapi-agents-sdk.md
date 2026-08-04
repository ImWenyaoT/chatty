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
- 画像、商品搜索和库存没有开放式决策，由 Harness 在进入 `Runner` 前直接执行并组成
  `RecommendationContext`；只向 Model 暴露知识检索和营销策略两个 function tools。
- 知识不在 Agent Loop 前预取；Model 通过固定的 `retrieve_knowledge` Tool 使用 `general` 或
  `product` scope，观察结果后最多改写 Query 再检索两次。
- 两个开放 Tool Schema 在一次 run 内保持稳定；Harness 通过 Context 末尾状态栏提示阶段，通过
  Tool input guardrail 执行批次快照门禁。
- 需求解析与最终草稿使用 SDK `output_type`，而不是提示模型输出 JSON 后手动解析；provider
  未遵守 Schema 时，仅允许一次 SDK `invalid_final_output` correction。
- Task Framer 使用无 `anyOf` / `$ref` 的扁平 `TaskFrameWire` 适配 DeepSeek 的 JSON Schema
  子集，再映射为领域 `TaskFrame(product_need?, knowledge_query?)`；DeepSeek 特有的
  `properties` 实例包装只在 SDK `invalid_final_output` handler 中确定性解包，不再次调用 Model。
- 不依赖 provider 是否遵守 `parallel_tool_calls`。同批 Tool call 先统一裁决，本地执行并发上限
  设为 1，避免依赖步骤读取到批次中途变化的 Evidence。

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
