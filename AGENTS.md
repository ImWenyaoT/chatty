# AGENTS.md

## TL;DR

- 请保持对话语言为中文。
- 我的系统为 Mac/Linux。
- 生成代码时添加函数级注释。
- 踏踏实实写 test，多写 test，让 test coverage 尽可能高。
- 认真做好 CI/CD，千方百计避免 messed up。
- 在 agentic coding 时代，所有能被自动验证的行为都应该被自动验证。

## 命令（全部在仓库根目录执行）

- 安装依赖：`pnpm install --frozen-lockfile`
- 开发服务：`pnpm dev`（Next.js app `@chatty/web`）
- 测试：`pnpm test`（workspace 全包，node 原生 `node --test --import tsx`，没有 vitest/turbo）
- Lint：`pnpm lint`（Biome，`pnpm lint:fix` 自动修）
- 类型检查：`pnpm typecheck`
- 核心包快速构建：`pnpm build:skeleton`
- 冒烟（无 LLM 核心数据链路）：`pnpm smoke`
- 金标回归：`pnpm eval`（harness lane，需真实 LLM）

## 自动化测试原则

- 新增或修改行为时，先写能失败的测试，再写实现；如果行为可自动验证，就必须进自动验证。
- 单元测试覆盖纯函数、schema、parser、policy、repository 和工具注册表等确定性逻辑。
- 集成测试覆盖跨包契约、Next.js route、SQLite/session/trace/memory、agentic search 工具循环和 harness step。
- smoke 覆盖无网络主链路，确保没有 LLM key 时系统仍可跑。
- 真实 LLM 行为用 `pnpm eval` 和 `.github/workflows/eval.yml` 的手动 workflow 兜住；prompt、tool loop、judge 阈值变化必须更新金标或说明风险。
- 每次新增质量门禁命令或 CI 步骤，同步更新 `packages/shared/src/quality-gates.ts`，让测试锁住 CI 契约。

## 数据红线（公开仓库）

- `docs/jd.md` 是只读输入，不要直接修改；需求理解和架构收束只能引用它，不能把实现决策反写进去。
- 本仓库开源，但业务数据来自真实店铺：真实客户信息（姓名/电话/地址/对话原文）任何情况下不得入库。
- `rag-service/data/`、`data/`、`*.db` 已在 .gitignore 硬性排除，不要用 `git add -f` 绕过。
- 手写金标 YAML（`eval/golden/`）里的客户 ID 用 `cx-*`/`golden-*` 形态，地址只到区级，对话原文重写为等价合成表述，提交前人工核查并脱敏。
- 店名/店铺电话同样属于个人信息：仓库内一律用占位符（示例租衣店 / 18800000000）；真实值仅限本地调试时临时改入，绝不提交。

## 仓库清洁维护

- `.gitignore` 是随项目演进维护的边界文件；新增本地数据、生成物、缓存、数据库、评测输出或工具产物时，先判断是否需要同步更新 `.gitignore`。
- 删除比优化重要：发现低于下限或超出上限的历史残留，优先删除或归档，再考虑抽象和重构。
- 功能实现遵守 `docs/development-method.md`：先贴近 `docs/jd.md`，再从 `openclaw`、`codex`、`claude-code` 做参考实现三选一；调试采用搭积木复现法，最小失败块必须沉淀为自动化回归。

## 代码风格

- TypeScript strict mode。
- 单引号、无分号。
- 优先函数式写法。
- 改动代码要补对应测试，即使没人要求。
- CI 见 `.github/workflows/ci.yml`；提交前 `pnpm lint` 和 `pnpm test` 必须全绿。

## 结构速查

- `packages/*`：shared / db / agent-core / llm（主线 harness）
- `apps/web`：Next.js playground + dashboard
- `eval/`：朴素金标回归（judge + golden runner + 场景 YAML；根级、非 workspace 包，`pnpm eval`）
- 架构设计主文档：`docs/design.md`（设计选择 + 代码结构 + 架构图；改动 harness 组件必须同步更新）
- 补充图集：`docs/current-architecture.md`
- 技术决策：`docs/tech-stack-decisions.md`
- 开发方法：`docs/development-method.md`（参考实现三选一 + 搭积木复现法）
- 历史文档：`docs/archive/`

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues; external pull requests are not a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The repo uses the default canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.

## PR instructions

- Title format: `[chatty] <Title>`
- Always run `pnpm lint` and `pnpm test` before committing.
