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

## 代码风格

- TypeScript strict mode；单引号、无分号；优先函数式写法
- CI 见 `.github/workflows/ci.yml`；提交前 `pnpm lint` 和 `pnpm test` 必须全绿
- 改动代码要补对应测试，即使没人要求

## 结构速查

- `packages/*`：shared / db / agent-core / llm（主线 harness）
- `apps/web`：Next.js playground + dashboard
- `rag-service`：冻结的 legacy lane（金标评测保活，勿动 src）
- 架构与决策：`docs/architecture.md`、`docs/tech-stack-decisions.md`
