# AGENTS.md

对话保持中文；生成代码添加函数级注释；多写 test，让覆盖尽可能高。

## 命令（全部在仓库根目录执行）

- 安装依赖：`pnpm install --frozen-lockfile`
- 开发服务：`pnpm dev`（Next.js app `@chatty/web`）
- 测试：`pnpm test`（workspace 全包，node 原生 `node --test --import tsx`，没有 vitest/turbo）
- Lint：`pnpm lint`（Biome，`pnpm lint:fix` 自动修）
- 类型检查：`pnpm typecheck`；骨架包快速构建 `pnpm build:skeleton`
- 冒烟（无 LLM 核心数据链路）：`pnpm smoke`
- 金标回归：`pnpm eval`（harness lane，需真实 LLM）

## 数据红线（公开仓库）

- 本仓库开源，但业务数据来自真实店铺：真实客户信息（姓名/电话/地址/对话原文）**任何情况下不得入库**。
- `rag-service/data/`、`data/`、`*.db` 已在 .gitignore 硬性排除，不要用 `git add -f` 绕过。
- 手写金标 YAML（`eval/golden/`）里的客户 ID 用 `cx-*`/`golden-*` 形态，地址只到区级，
  对话原文重写为等价合成表述——**提交前人工核查并脱敏**。
- 店名/店铺电话同样属于个人信息：仓库内一律用占位符（示例租衣店 / 18800000000）；
  真实值仅限本地调试时临时改入，**绝不提交**（提交前 `git grep` 自查）。

## 代码风格

- TypeScript strict mode；单引号、无分号；优先函数式写法
- CI 见 `.github/workflows/ci.yml`；提交前 `pnpm lint` 和 `pnpm test` 必须全绿
- 改动代码要补对应测试，即使没人要求

## 结构速查

- `packages/*`：shared / db / agent-core / llm（主线 harness）
- `apps/web`：Next.js playground + dashboard
- `eval/`：朴素金标回归（judge + golden runner + 场景 YAML；根级、非 workspace 包，`pnpm eval`）
- 架构与决策：`docs/architecture.md`、`docs/tech-stack-decisions.md`
- harness 组件映射：`docs/design.md`（The Harness Is The Product，living doc——
  改动编排/循环/context/parser/executor/工具的提交必须同步更新对应小节）
