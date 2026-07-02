# AGENTS.md

## TL;DR

- 请保持对话语言为中文
- 我的系统为 Mac/Linux
- 请在生成代码时添加函数级注释
- 踏踏实实写 test，多写 test，让 test coverage 尽可能高
- 认真做好 CI/CD，千方百计避免 messed up
- 对于一个新项目，做好 top-down design(specs driven)，从 features 和 requirement 出发，设计 architecture 和 interface，一层一层设计下去
- 对于一个快速增长的项目，先切分好文件，再切分好 module，再划分成一堆 service 或者 executives，提前解耦
- 对于一类的功能，提前做好 design pattern 的功课，减少重复，增加复用
- 如果 codebase 足够大，要么一点点修复但是提高 test coverage，要么保持好 specs、test、interface 直接推倒重写，有空就重写，永远重写，重写重写重写

## Setup commands
- Install deps: `pnpm install`
- Run tests: `pnpm test`
 
## Code style
- TypeScript strict mode
- Single quotes, no semicolons
- Use functional patterns where possible

## Dev environment tips
- Use `pnpm dlx turbo run where <project_name>` to jump to a package instead of scanning with `ls`.
- Run `pnpm install --filter <project_name>` to add the package to your workspace so Vite, ESLint, and TypeScript can see it.
- Use `pnpm create vite@latest <project_name> -- --template react-ts` to spin up a new React + Vite package with TypeScript checks ready.
- Check the name field inside each package's package.json to confirm the right name—skip the top-level one.
 
## Testing instructions
- Find the CI plan in the .github/workflows folder.
- Run `pnpm turbo run test --filter <project_name>` to run every check defined for that package.
- From the package root you can just call `pnpm test`. The commit should pass all tests before you merge.
- To focus on one step, add the Vitest pattern: `pnpm vitest run -t "<test name>"`.
- Fix any test or type errors until the whole suite is green.
- After moving files or changing imports, run `pnpm lint --filter <project_name>` to be sure ESLint and TypeScript rules still pass.
- Add or update tests for the code you change, even if nobody asked.
 
## PR instructions
- Title format: [<project_name>] <Title>
- Always run `pnpm lint` and `pnpm test` before committing.
