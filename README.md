<p align="center"><strong>Chatty</strong></p>
<p align="center">卖家侧客服场景的单 Agent harness · TypeScript / Node.js · DeepSeek 驱动</p>
<p align="center">
  <a href="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml/badge.svg" /></a>
</p>
<p align="center">简体中文 | <a href="README.en.md">English</a></p>

---

`agent = model + harness`：model 固定 `deepseek-v4-pro`，harness 才是可演进的部分。一条客服消息跑成一个有界闭环——task scheduling → context 准备 → Agents SDK 工具轮 → 策略化执行 → 无工具收尾 → trace，全程可观测、可回归。playground 的真实主链路需要 DeepSeek API key；不需要 key 的单测与 smoke 使用显式 stub 验证确定性边界。

## 能力

- **Harness 闭环** — 确定性任务调度 + 有界 loop 控制；缺少 key 时返回配置错误，provider 或输出校验失败时返回上游错误，不把模型故障伪装成成功回复。
- **Agentic 检索** — scheduled task 只暴露所需工具；模型在一轮有界工具阶段调用 `search_knowledge`（SQLite FTS5 trigram + 中文 2 字词 LIKE 回退），随后由无工具 SDK run 基于证据收尾。
- **策略化 executor** — 工具执行前过 allow / require_approval / deny；高风险工具（如退款）永不自动执行。
- **Memory & trace** — SQLite 持久化 session / trace / memory；一次 turn 的落库与续接记忆由测试锁定。
- **LLM 可观测** — 生产模型调用走 DeepSeek pro + OpenAI Agents SDK 的 Chat Completions model；逐次调用记录 KV cache 命中率与成本。
- **金标回归** — `eval/` 朴素金标 + LLM-judge，`pnpm eval` 一条命令跑完。

## 快速开始

```bash
pnpm install --frozen-lockfile
pnpm dev      # Next.js playground（apps/web）
pnpm test     # 全 workspace 单测
pnpm smoke    # 使用测试替身的核心数据链路冒烟
pnpm eval     # 金标回归（需真实 LLM key）
```

运行 playground 前必须配置 `OPENAI_API_KEY`（DeepSeek 的 OpenAI-format key）；模型步骤走 DeepSeek pro + Agents SDK。缺少 key 时消息接口返回 503。`pnpm dev` 默认把 session、trace、memory 和会话历史持久化到 `data/chatty.sqlite`；需要改路径时设置 `CHATTY_DB_PATH`。

## 结构

| 路径 | 作用 |
| --- | --- |
| [`packages/agent-core`](packages/agent-core) | harness 核心：task scheduling、context、run policy、tool execution、agentic search |
| [`packages/llm`](packages/llm) | DeepSeek Chat Completions model 的 Agents SDK 适配 + usage 遥测 |
| [`packages/db`](packages/db) | SQLite：session / trace / memory / knowledge（FTS5） |
| [`packages/shared`](packages/shared) | 跨包类型、schema 与浏览器安全契约 |
| [`apps/web`](apps/web) | Next.js playground + dashboard |
| [`eval/`](eval) | 朴素金标回归（judge + golden runner + 场景 YAML） |

## 质量门禁

`pnpm test` / `pnpm test:fullstack` / `pnpm test:coverage` / `pnpm test:coverage:core` / `pnpm smoke` / `pnpm typecheck` / `pnpm lint` 在 PR 与 `main` 上由 [CI](.github/workflows/ci.yml) 跑；full-stack 门禁覆盖 Next API、SQLite 与 worker 的真实联调。真实 LLM 的金标回归是手动 workflow（[`eval.yml`](.github/workflows/eval.yml)）。命令以根 [`package.json`](package.json) 为真相源，CI 测试直接校验 workflow 与这些脚本的连接。

推送 `v*` tag 会触发 [Release workflow](.github/workflows/release.yml)：构建并真实启动 Next.js standalone server，以持久 SQLite 路径检查 `/api/health`，随后发布可运行的 GitHub Release 压缩包。部署环境只需 Node.js 24，并把 `CHATTY_DB_PATH` 指向持久卷。

## 数据说明

本仓库开源，但业务源自真实店铺：真实客户信息与店铺隐私数据一律不入库，示例统一用占位符（示例租衣店 / 18800000000）。约定见 [AGENTS.md](AGENTS.md)。

## 许可

以 [MIT](LICENSE) 许可发布。
