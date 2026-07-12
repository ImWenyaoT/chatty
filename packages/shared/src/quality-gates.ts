export const AUTOMATED_BEHAVIOR_COVERAGE_RULE =
  "在 agentic coding 时代，所有能被自动验证的行为都应该被自动验证；单元测试、集成测试、smoke、typecheck、lint、build 与金标 eval 共同构成质量门禁。";

export const DEVELOPMENT_METHOD_RULE =
  "功能实现必须先贴近 docs/jd.md 下限，再从 openclaw、codex、claude-code 中为该能力单选一个主参考；调试必须用搭积木复现法收敛到最小可失败块，再把修复沉淀为自动化回归。";

export type QualityCommand = {
  readonly scriptName: string;
  readonly command: string;
  readonly purpose: string;
};

export type ReferenceDebuggingMethod = {
  readonly allowedReferences: readonly ["openclaw", "codex", "claude-code"];
  readonly requiresSingleReferenceChoice: boolean;
  readonly requiresSmallestReproduction: boolean;
};

export type PullRequestCheck = {
  readonly name: string;
  readonly command: string;
  readonly purpose: string;
};

export const REFERENCE_DEBUGGING_METHOD: ReferenceDebuggingMethod = {
  allowedReferences: ["openclaw", "codex", "claude-code"],
  requiresSingleReferenceChoice: true,
  requiresSmallestReproduction: true,
};

export const REQUIRED_LOCAL_QUALITY_COMMANDS: readonly QualityCommand[] = [
  {
    scriptName: "build:skeleton",
    command:
      "tsc -b packages/shared packages/db packages/agent-core packages/llm --pretty false",
    purpose: "先编译核心包，尽早发现跨包接口漂移",
  },
  {
    scriptName: "lint",
    command: "eslint . && prettier . --check",
    purpose: "用 ESLint 和 Prettier 固定格式与基础静态规则",
  },
  {
    scriptName: "smoke",
    command: "pnpm build:skeleton && node scripts/smoke.mts",
    purpose: "覆盖无网络核心数据链路，验证 SQLite/session/trace/memory 连续性",
  },
  {
    scriptName: "test",
    command: "pnpm -r --if-present test",
    purpose: "运行 workspace 单元测试和轻量集成测试",
  },
  {
    scriptName: "test:frontend",
    command: "pnpm --filter @chatty/web test:frontend",
    purpose: "锁住 playground 的视觉、无障碍和交互反馈体验契约",
  },
  {
    scriptName: "test:coverage",
    command: "pnpm --filter @chatty/web test:coverage",
    purpose: "用 Node 原生 coverage 阈值约束 web 核心业务路径的回归",
  },
  {
    scriptName: "typecheck",
    command:
      "pnpm -r --if-present typecheck && tsc -p eval/tsconfig.json --noEmit",
    purpose: "验证全部 TypeScript 契约和 eval runner 类型",
  },
  {
    scriptName: "build",
    command: "pnpm -r --if-present build",
    purpose: "确认所有 workspace 包可生产构建",
  },
];

export const REQUIRED_PULL_REQUEST_CHECKS: readonly PullRequestCheck[] = [
  {
    name: "Build package skeleton",
    command: "pnpm build:skeleton",
    purpose: "先发现 shared/db/agent-core/llm 的接口破坏",
  },
  {
    name: "Lint and format",
    command: "pnpm lint",
    purpose: "阻断格式和基础静态检查回退",
  },
  {
    name: "Smoke test (core data path, no network)",
    command: "node scripts/smoke.mts",
    purpose: "验证核心数据链路不依赖外部 LLM 即可运行",
  },
  {
    name: "Test workspaces",
    command: "pnpm test",
    purpose: "运行全部自动化单元测试和轻量集成测试",
  },
  {
    name: "Control-plane integration",
    command: "pnpm test:control-plane-integration",
    purpose:
      "验证 durable workflow、worker、memory 与 API read model 的跨模块语义",
  },
  {
    name: "Web core coverage",
    command: "pnpm test:coverage",
    purpose: "阻断 web 核心库的行、分支和函数覆盖率回退",
  },
  {
    name: "Frontend experience contract",
    command: "pnpm test:frontend",
    purpose: "验证 seller playground 的前端体验契约",
  },
  {
    name: "Typecheck workspaces",
    command: "pnpm typecheck",
    purpose: "阻断类型契约漂移",
  },
  {
    name: "Build workspaces",
    command: "pnpm build",
    purpose: "确认最终构建链路仍可用",
  },
];

/** 返回本地必须可运行的质量命令名称，供测试和文档生成保持同源。 */
export function getRequiredQualityCommandNames(): string[] {
  return REQUIRED_LOCAL_QUALITY_COMMANDS.map((command) => command.scriptName);
}

/** 返回 PR 必须执行的 CI 步骤名称，顺序即推荐失败定位顺序。 */
export function getRequiredPullRequestCheckNames(): string[] {
  return REQUIRED_PULL_REQUEST_CHECKS.map((check) => check.name);
}
