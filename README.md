<p align="center"><strong>Chatty</strong></p>
<p align="center">卖家侧客服场景的 agent harness · TypeScript 单体 · DeepSeek 驱动</p>
<p align="center">
  <a href="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ImWenyaoT/chatty/actions/workflows/ci.yml/badge.svg" /></a>
</p>
<p align="center">简体中文 | <a href="README.en.md">English</a></p>

---

`agent = model + harness`：model 固定 `deepseek-v4-pro`，harness 才是可演进的部分。一条客服消息跑成一个有界闭环——task scheduling → context 拼接 → 模型合成 → output parser → 策略化 executor → trace，全程可观测、可回归，无 LLM key 也能跑主链路。

## 能力

- **Harness 闭环** — 确定性任务调度 + 有界 loop 控制；无 key 或模型失败时回退确定性 composer（“无 key 可跑”是不变量）。
- **Agentic 检索** — compose 内的有界工具循环，模型自主决定是否调 `search_knowledge`（SQLite FTS5 trigram + 中文 2 字词 LIKE 回退），最多 3 次搜索后强制作答。
- **策略化 executor** — 工具执行前过 allow / require_approval / deny；高风险工具（如退款）永不自动执行。
- **Memory & trace** — SQLite 持久化 session / trace / memory；一次 turn 的落库与续接记忆由测试锁定。
- **LLM 可观测** — compose 默认走 DeepSeek pro + OpenAI Agents SDK；逐次调用记录 KV cache 命中率与成本。
- **金标回归** — `eval/` 朴素金标 + LLM-judge，`pnpm eval` 一条命令跑完。

## 快速开始

```bash
pnpm install --frozen-lockfile
pnpm dev      # Next.js playground（apps/web）
pnpm test     # 全 workspace 单测
pnpm smoke    # 无 LLM 的核心数据链路冒烟
pnpm eval     # 金标回归（需真实 LLM key）
```

配置 `OPENAI_API_KEY`（DeepSeek 的 OpenAI-format key）后，playground 的 compose 步默认走 DeepSeek pro + Agents SDK。

## 结构

| 路径 | 作用 |
| --- | --- |
| [`packages/agent-core`](packages/agent-core) | harness 核心：task scheduling、context、parser、executor、policy、agentic search |
| [`packages/llm`](packages/llm) | DeepSeek adapter（Chat Completions + Agents SDK）+ usage 遥测 |
| [`packages/db`](packages/db) | SQLite：session / trace / memory / knowledge（FTS5） |
| [`packages/shared`](packages/shared) | 跨包类型、schema、质量门禁契约 |
| [`apps/web`](apps/web) | Next.js playground + dashboard |
| [`eval/`](eval) | 朴素金标回归（judge + golden runner + 场景 YAML） |

## 质量门禁

`pnpm test` / `pnpm smoke` / `pnpm typecheck` / `pnpm lint` 在 PR 与 `main` 上由 [CI](.github/workflows/ci.yml) 跑；真实 LLM 的金标回归是手动 workflow（[`eval.yml`](.github/workflows/eval.yml)）。命令与 CI 步骤的契约是可执行文档，见 [`quality-gates.ts`](packages/shared/src/quality-gates.ts)。

## 文档

- 架构设计主文档 — [docs/design.md](docs/design.md)
- 补充图集 — [docs/current-architecture.md](docs/current-architecture.md)
- 技术决策 — [docs/tech-stack-decisions.md](docs/tech-stack-decisions.md)
- 开发方法 — [docs/development-method.md](docs/development-method.md)

## 数据说明

本仓库开源，但业务源自真实店铺：真实客户信息与店铺隐私数据一律不入库，示例统一用占位符（示例租衣店 / 18800000000）。约定见 [AGENTS.md](AGENTS.md)。

## 许可

以 [MIT](LICENSE) 许可发布。
