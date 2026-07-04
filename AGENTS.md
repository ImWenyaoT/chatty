# AGENTS.md

对话保持中文；生成代码添加函数级注释；多写 test，让覆盖尽可能高。

## 命令（全部在仓库根目录执行）

- 安装依赖：`pnpm install --frozen-lockfile`
- 开发服务：`pnpm dev`（Next.js app `@chatty/web`）
- 测试：`pnpm test`（workspace 全包，node 原生 `node --test --import tsx`，没有 vitest/turbo）
- Lint：`pnpm lint`（Biome，`pnpm lint:fix` 自动修）
- 类型检查：`pnpm typecheck`；骨架包快速构建 `pnpm build:skeleton`
- 冒烟（无 LLM 全数据链路）：`pnpm smoke`
- 金标回归：`pnpm --filter rental-rag-service eval`
- 失败用例晋升金标：`pnpm promote:failure-case`

## 数据红线（公开仓库）

- 本仓库开源，但业务数据来自真实店铺：真实客户信息（姓名/电话/地址/对话原文）**任何情况下不得入库**。
- `rag-service/data/`、`data/`、`*.db` 已在 .gitignore 硬性排除，不要用 `git add -f` 绕过。
- `pnpm promote:failure-case` 会把真实 trace 晋升为金标 YAML——**提交前必须人工核查并脱敏**
  （客户 ID 用 `cx-*`/`golden-*` 形态，地址只到区级，对话原文重写为等价合成表述）。
- 店铺对客公开的联系方式（店名/店铺电话）允许出现在政策文档与金标场景中。

## 代码风格

- TypeScript strict mode；单引号、无分号；优先函数式写法
- CI 见 `.github/workflows/ci.yml`；提交前 `pnpm lint` 和 `pnpm test` 必须全绿
- 改动代码要补对应测试，即使没人要求

## 结构速查

- `packages/*`：shared / db / agent-core / llm（主线 harness）
- `apps/web`：Next.js playground + dashboard
- `rag-service`：冻结的 legacy lane（金标评测保活，勿动 src）
- 架构与决策：`docs/architecture.md`、`docs/tech-stack-decisions.md`
