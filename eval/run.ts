// 朴素金标回归运行器（单 lane）。
// 用法：
//   pnpm eval                          # 跑全部金标场景（harness lane，唯一活路径）
//   pnpm eval -- --filter store-contact # 只跑名字匹配的场景
//   pnpm eval -- --repeat 3            # 跑 3 次聚合，抵消 LLM judge 评分噪声
//   pnpm eval -- --timeout-ms 60000    # 限制每次 harness/judge 网络请求
//   pnpm eval -- --save v1             # 跑完把结果存到 eval/reports/v1.json
//   pnpm eval -- --baseline v1         # 跑完和 eval/reports/v1.json 对比
//
// 被测面：runCustomerServiceHarnessStep 进程内直调（复刻 route.ts 步骤 2→4→5b，
//   去 HTTP/auth/trace 持久化），场景在 eval/golden/，每场景独立 tmp SQLite（§5.2），
//   judge 由 runner 同步调用回填分数。需先 pnpm build:skeleton（@rental/* 从 dist 解析）。
//
// R4 已删检索子系统与飞轮、R5 删除整个 legacy rag-service，legacy lane 一并退役——
//   本 runner 只保留 harness 一条路径，不再有 --target 概念。
import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUSTOMER_SERVICE_SDK_INSTRUCTIONS,
  createCustomerServiceSdkRunner,
  createDefaultToolRegistry,
  type CustomerServiceSdkRunner,
  runCustomerServiceHarnessStep,
  type ToolRegistry,
} from "@rental/agent-core";
import {
  createKnowledgeRepository,
  createMemoryRepository,
  type Db,
  type MemoryRepository,
  openDatabase,
  syncKnowledgeIndex,
} from "@rental/db";
import {
  createAgentsSdkCustomerServiceTextRunner,
  createDeepSeekAgentsModelFromEnv,
  readLlmEnv,
} from "@rental/llm";
import type { ConversationEvent } from "@rental/shared";
import YAML from "yaml";
import { evaluateCustomerServiceReply } from "./judge.js";
import { parseEvalTimeoutMs, withEvalDeadline } from "./deadline.js";

interface ExpectBlock {
  contains?: string[];
  /** OR 语义：answer 命中其中任意一个即可（用于"M 或 L"这类单值不可能同时出现的断言）。 */
  containsAny?: string[];
  notContains?: string[];
  /** 本轮回复不能和上一轮逐字相同（抓机器人复读，如连续 repair）。 */
  notSameAsPrev?: boolean;
  minScore?: number;
  action?: string;
  actionIn?: string[];
  // 以下是 legacy orchestrator 的实现词汇（stage/profile），harness 场景不支持——
  // 出现即判 FAIL（防静默跳过，豁免走 YAML 删断言并落档 eval/golden/README.md）。
  stage?: unknown;
  stageIn?: unknown;
  profile?: unknown;
}

interface ScenarioStep {
  user: string;
  expect?: ExpectBlock;
}

interface Scenario {
  name: string;
  description?: string;
  customerId: string;
  productId?: string;
  conversationId?: string;
  steps: ScenarioStep[];
}

interface StepResult {
  user: string;
  answer: string;
  action?: string;
  score?: number;
  failures: string[];
}

interface ScenarioResult {
  name: string;
  description?: string;
  passed: boolean;
  steps: StepResult[];
  avgScore: number;
  /** --repeat 聚合：N 次运行里通过的次数 */
  passCount?: number;
  /** --repeat 聚合：总运行次数 */
  runCount?: number;
  /** --repeat 聚合：每次运行的场景均分样本（用于看噪声幅度） */
  scoreSamples?: number[];
  errors?: string[];
}

/** 单个回合的被测结果：harness 步的回复 + trace 里的 action/taskKind + judge 回填分。 */
interface TurnOutcome {
  answer: string;
  action?: string;
  taskKind?: string;
  score?: number;
  evaluationError?: string;
}

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(EVAL_DIR, "golden");
const REPORTS_DIR = path.join(EVAL_DIR, "reports");
const TMP_DIR = path.join(EVAL_DIR, ".tmp");
// 知识语料在仓库根（B1 迁移后的唯一权威位置），harness lane 每场景库同步一次（I1 幂等）
const KNOWLEDGE_DIR = path.resolve(EVAL_DIR, "..", "knowledge");

/** 极简 argv 解析：把 `--key value` / `--flag` 收成一个 map，不做别的。 */
function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/** 从金标目录读取全部（或匹配 filter 的）场景 YAML。 */
async function loadScenarios(
  goldenDir: string,
  filter?: string,
): Promise<Scenario[]> {
  const entries = await fs.readdir(goldenDir);
  const files = entries.filter((name) => /\.ya?ml$/i.test(name));
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(goldenDir, file), "utf8");
    const parsed = YAML.parse(raw) as Scenario;
    if (!parsed?.name || !Array.isArray(parsed.steps)) {
      console.warn(`skip ${file}: missing name or steps`);
      continue;
    }
    if (filter && !parsed.name.includes(filter)) continue;
    scenarios.push(parsed);
  }
  return scenarios;
}

/**
 * 单步断言检查：行为断言（contains/containsAny/notContains/notSameAsPrev/action）
 * 直接比对 TurnOutcome。stage/stageIn/profile 是 legacy 实现词汇（§5.3），harness
 * 场景文件里出现即失败——防静默跳过，豁免走 YAML 里删除断言并落档
 * eval/golden/README.md，而不是 runner 里悄悄放过。
 */
function checkExpectations(
  expect: ExpectBlock,
  turn: TurnOutcome,
  prevAnswer?: string,
): string[] {
  const failures: string[] = [];
  if (turn.evaluationError) failures.push(turn.evaluationError);
  for (const needle of expect.contains ?? []) {
    if (!turn.answer.includes(needle))
      failures.push(`contains "${needle}" not found in answer`);
  }
  if (
    expect.containsAny &&
    !expect.containsAny.some((needle) => turn.answer.includes(needle))
  ) {
    failures.push(
      `containsAny [${expect.containsAny.join(", ")}] none found in answer`,
    );
  }
  if (
    expect.notSameAsPrev &&
    prevAnswer !== undefined &&
    turn.answer.trim() === prevAnswer.trim()
  ) {
    failures.push("notSameAsPrev: 本轮回复与上一轮逐字相同（机器人复读）");
  }
  for (const needle of expect.notContains ?? []) {
    if (turn.answer.includes(needle))
      failures.push(`notContains "${needle}" unexpectedly present`);
  }
  if (expect.stage || expect.stageIn || expect.profile) {
    failures.push(
      "stage/profile 是 legacy 实现词汇，harness 场景不支持（design §5.3，豁免清单见 eval/golden/README.md）",
    );
  }
  if (expect.action && turn.action !== expect.action) {
    failures.push(`action expected=${expect.action} got=${turn.action}`);
  }
  if (expect.actionIn && !expect.actionIn.includes(turn.action ?? "")) {
    failures.push(
      `action expected one of [${expect.actionIn.join(", ")}] got=${turn.action}`,
    );
  }
  return failures;
}

/** 每场景会话状态：独立 tmp SQLite + 记忆 repo + 注入的模型调用（§5.2）。 */
interface HarnessSession {
  db: Db;
  memory: MemoryRepository;
  registry: ToolRegistry;
  sdkRunner: CustomerServiceSdkRunner;
  conversationId: string;
  /** 本场景累积的对话（judge 的历史切片来源，口径含当前轮）。 */
  history: Array<{ role: string; content: string }>;
  turn: number;
  requestTimeoutMs: number;
}

/**
 * 构建 harness 生产 lane 注入：eval 与 apps/web 复用同一
 * createCustomerServiceSdkRunner（DeepSeek Agents SDK 工具循环 + 宽容文本回复，
 * 非 outputType——DeepSeek 两端点都不支持 json_schema，结构化输出不收敛）。使金标
 * 直接护航生产路径。无 OPENAI_API_KEY 时明确失败，不存在第二条 fallback lane。
 */
function createHarnessSdkRunner(): CustomerServiceSdkRunner {
  const env = readLlmEnv();
  if (!env.apiKey) throw new Error("OPENAI_API_KEY is required for eval");
  const model = createDeepSeekAgentsModelFromEnv();
  return createCustomerServiceSdkRunner(
    (opts) =>
      createAgentsSdkCustomerServiceTextRunner({
        instructions: opts.instructions,
        input: opts.input,
        model,
        modelName: env.chatModel,
        tools: opts.tools,
        toolChoice: opts.toolChoice,
        toolUseBehavior: opts.toolUseBehavior,
        maxTurns: opts.maxTurns,
        signal: opts.signal,
      }),
    { modelName: env.chatModel },
  );
}

/** 打开一个场景会话：删除重建独立 tmp SQLite，同步知识索引，装配 repos。 */
async function openHarnessSession(
  scenario: Scenario,
  requestTimeoutMs: number,
): Promise<HarnessSession> {
  const dbPath = path.join(TMP_DIR, `harness-${scenario.name}.sqlite`);
  await fs.mkdir(TMP_DIR, { recursive: true });
  await Promise.all(
    ["", "-wal", "-shm"].map((suffix) =>
      fs.rm(dbPath + suffix, { force: true }),
    ),
  );
  const db = openDatabase(dbPath);
  if (existsSync(KNOWLEDGE_DIR)) syncKnowledgeIndex(db, KNOWLEDGE_DIR);
  return {
    db,
    memory: createMemoryRepository(db),
    registry: createDefaultToolRegistry(createKnowledgeRepository(db)),
    sdkRunner: createHarnessSdkRunner(),
    conversationId:
      scenario.conversationId ??
      `${scenario.customerId}:${scenario.productId ?? "general"}`,
    history: [],
    turn: 0,
    requestTimeoutMs,
  };
}

/**
 * 被测面：把一句用户消息发给 harness 步（复刻 route.ts 步骤 2→4→5b），返回统一的
 * TurnOutcome。judge 与生产同一本体、由 runner 同步调用回填分数。
 */
async function sendTurn(
  scenario: Scenario,
  question: string,
  session: HarnessSession,
  requiresJudge: boolean,
): Promise<TurnOutcome> {
  const turnIndex = session.turn++;
  const event: ConversationEvent = {
    eventId: `eval-${scenario.name}-${turnIndex}`,
    type: "user_message",
    customerId: scenario.customerId,
    conversationId: session.conversationId,
    productId: scenario.productId,
    source: "customer",
    payload: { question },
    occurredAt: new Date().toISOString(),
  };
  const snapshot = session.memory.snapshot({
    customerId: scenario.customerId,
    conversationId: session.conversationId,
    productId: scenario.productId,
  });
  const harness = await withEvalDeadline(
    `harness:${scenario.name}:${turnIndex}`,
    session.requestTimeoutMs,
    (signal) =>
      runCustomerServiceHarnessStep({
        event,
        memory: snapshot,
        registry: session.registry,
        sessionStatus: "active",
        sdkRunner: session.sdkRunner,
        signal,
      }),
  );
  const answer = harness.step.reply ?? "";
  // route.ts 步骤 5b 同款连续性写入：只追加消息滑窗，不提升 profile 字段
  session.memory.appendRecentMessages(
    {
      customerId: scenario.customerId,
      productId: scenario.productId ?? "general",
      conversationId: session.conversationId,
    },
    [
      { role: "user", content: question },
      { role: "assistant", content: answer },
    ],
  );
  session.history.push(
    { role: "user", content: question },
    { role: "assistant", content: answer },
  );
  let score: number | undefined;
  let evaluationError: string | undefined;
  if (requiresJudge) {
    try {
      score = (
        await withEvalDeadline(
          `judge:${scenario.name}:${turnIndex}`,
          session.requestTimeoutMs,
          (signal) =>
            evaluateCustomerServiceReply(session.history.slice(-10), answer, {
              signal,
            }),
        )
      ).score;
    } catch (error) {
      // judge 失败不吞错也不中断场景：留 undefined，minScore 断言会以"未拿到评分"失败
      evaluationError = `judge failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`    ${evaluationError}`);
    }
  }
  return {
    answer,
    action: harness.trace.action.action,
    taskKind: harness.trace.task.kind,
    score,
    evaluationError,
  };
}

/** 跑一个场景的全部 step，按 minScore 落后置检查，返回聚合结果。 */
async function runScenario(
  scenario: Scenario,
  requestTimeoutMs: number,
): Promise<ScenarioResult> {
  const session = await openHarnessSession(scenario, requestTimeoutMs);
  const stepResults: StepResult[] = [];

  try {
    for (const step of scenario.steps) {
      const turn = await sendTurn(
        scenario,
        step.user,
        session,
        step.expect?.minScore !== undefined,
      );
      const failures = checkExpectations(
        step.expect ?? {},
        turn,
        stepResults[stepResults.length - 1]?.answer,
      );
      stepResults.push({
        user: step.user,
        answer: turn.answer,
        action: turn.action,
        score: turn.score,
        failures,
      });
    }
  } finally {
    session.db.close();
  }

  // minScore 检查在评分就位后做（sendTurn 已同步回填）
  for (let i = 0; i < scenario.steps.length; i++) {
    const minScore = scenario.steps[i].expect?.minScore;
    if (minScore === undefined) continue;
    const score = stepResults[i].score;
    if (score === undefined) {
      stepResults[i].failures.push(
        `minScore=${minScore} 但未拿到评分（评估失败？）`,
      );
    } else if (score < minScore) {
      stepResults[i].failures.push(`score=${score} < minScore=${minScore}`);
    }
  }

  const scores = stepResults
    .map((s) => s.score)
    .filter((s): s is number => typeof s === "number");
  const avgScore =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const passed = stepResults.every((s) => s.failures.length === 0);
  const errors = [
    ...new Set(
      stepResults.flatMap((step) =>
        step.failures.filter((failure) => failure.startsWith("judge failed:")),
      ),
    ),
  ];

  return {
    name: scenario.name,
    description: scenario.description,
    passed,
    steps: stepResults,
    avgScore,
    errors,
  };
}

/**
 * 并发映射，保序、限流、无第三方依赖。用于并行跑相互独立的场景，
 * 把评测墙钟时间从「场景数 × 单场景」降到「场景数 / 并发数 × 单场景」。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

// 跑一整套场景一次。每场景用独立 tmp SQLite，可并发；瓶颈是 LLM inference，并发直接缩墙钟。
async function runAllScenarios(
  scenarios: Scenario[],
  concurrency = 6,
  requestTimeoutMs = 60_000,
): Promise<ScenarioResult[]> {
  return mapWithConcurrency(
    scenarios,
    Math.max(1, concurrency),
    async (scenario) => {
      const startedAt = performance.now();
      console.log(`  → ${scenario.name}`);
      try {
        const result = await runScenario(scenario, requestTimeoutMs);
        console.log(
          `  ${result.passed ? "✓" : "✗"} ${scenario.name} (${Math.round(performance.now() - startedAt)}ms)`,
        );
        return result;
      } catch (error) {
        console.error(
          `    ${scenario.name} error: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.log(
          `  ✗ ${scenario.name} (${Math.round(performance.now() - startedAt)}ms)`,
        );
        return {
          name: scenario.name,
          description: scenario.description,
          passed: false,
          steps: [],
          avgScore: 0,
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    },
  );
}

// 把 N 次运行聚合成单份报告：avgScore 取均值、passed 记通过率，steps 取最后一次用于展示。
// 取均值是为了抵消 LLM 评分的随机噪声（实测可达 ±2），让 prompt 改动的真实信号显出来。
function aggregateRuns(
  scenarios: Scenario[],
  runs: ScenarioResult[][],
): ScenarioResult[] {
  return scenarios.map((scenario) => {
    const perRun = runs
      .map((r) => r.find((x) => x.name === scenario.name))
      .filter((x): x is ScenarioResult => !!x);
    const scoreSamples = perRun.map((r) => r.avgScore);
    const avgScore = scoreSamples.length
      ? scoreSamples.reduce((a, b) => a + b, 0) / scoreSamples.length
      : 0;
    const passCount = perRun.filter((r) => r.passed).length;
    const last = perRun[perRun.length - 1];
    return {
      name: scenario.name,
      description: scenario.description,
      passed: passCount === perRun.length && perRun.length > 0, // 全过才算稳定通过
      steps: last?.steps ?? [],
      avgScore,
      passCount,
      runCount: perRun.length,
      scoreSamples,
      errors: [...new Set(perRun.flatMap((result) => result.errors ?? []))],
    };
  });
}

/** 把聚合结果打印成人读报告。 */
function printReport(results: ScenarioResult[]) {
  console.log("\n========== Eval Report ==========");
  for (const r of results) {
    const stable = (r.runCount ?? 1) > 1;
    const passText = stable
      ? `pass ${r.passCount}/${r.runCount}`
      : r.passed
        ? "PASS"
        : "FAIL";
    const badge = r.passed ? "✅" : (r.passCount ?? 0) > 0 ? "🟡" : "❌";
    const sampleText =
      stable && r.scoreSamples
        ? ` [${r.scoreSamples.map((s) => s.toFixed(1)).join("/")}]`
        : "";
    console.log(
      `\n${badge} ${passText}  ${r.name}  (avgScore=${r.avgScore.toFixed(2)})${sampleText}`,
    );
    if (r.description) console.log(`        ${r.description}`);
    const displayedFailures = new Set(r.steps.flatMap((step) => step.failures));
    for (const error of r.errors ?? []) {
      if (!displayedFailures.has(error)) console.log(`     ✗  ${error}`);
    }
    for (const step of r.steps) {
      const scoreText = step.score !== undefined ? ` [${step.score}/10]` : "";
      const actionText = step.action ? ` {${step.action}}` : "";
      console.log(`   > user: ${step.user}${scoreText}${actionText}`);
      console.log(
        `     ans : ${step.answer.slice(0, 80)}${step.answer.length > 80 ? "…" : ""}`,
      );
      for (const f of step.failures) {
        console.log(`     ✗  ${f}`);
      }
    }
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n=================================`);
  console.log(`Total: ${passed}/${results.length} passed`);
  console.log(`=================================\n`);
}

/** 把结果落盘到 eval/reports/<tag>.json（供 --baseline 后续对比）。 */
async function saveReport(
  tag: string,
  results: ScenarioResult[],
  promptVersion: string,
) {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `${tag}.json`);
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        promptVersion,
        timestamp: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Saved report -> ${file}`);
}

/** 和已存基线报告对比，逐场景打印 avgScore 变化与 PASS 状态迁移。 */
async function compareBaseline(baselineTag: string, results: ScenarioResult[]) {
  const file = path.join(REPORTS_DIR, `${baselineTag}.json`);
  let baseline: { promptVersion: string; results: ScenarioResult[] };
  try {
    baseline = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    console.error(
      `baseline not found: ${file} — 传了 --baseline 却读不到基线文件，拒绝静默跳过对比`,
    );
    process.exit(1);
  }

  console.log(
    `\n========== Compare vs ${baselineTag} (${baseline.promptVersion}) ==========`,
  );
  for (const current of results) {
    const prev = baseline.results.find((r) => r.name === current.name);
    if (!prev) {
      console.log(
        `  NEW     ${current.name}  avgScore=${current.avgScore.toFixed(2)}`,
      );
      continue;
    }
    const delta = current.avgScore - prev.avgScore;
    const arrow = delta > 0.05 ? "↑" : delta < -0.05 ? "↓" : "→";
    const passChange =
      prev.passed !== current.passed
        ? current.passed
          ? " [PASS regained]"
          : " [PASS lost]"
        : "";
    console.log(
      `  ${arrow}   ${current.name}  ${prev.avgScore.toFixed(2)} -> ${current.avgScore.toFixed(2)} (Δ${delta.toFixed(2)})${passChange}`,
    );
  }
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repeat = Math.max(1, Number(args.repeat ?? 1) || 1);
  // 场景并发数。默认 6，兼顾墙钟与 DeepSeek 速率限制。
  const concurrency = Math.max(1, Number(args.concurrency ?? 6) || 6);
  const requestTimeoutMs = parseEvalTimeoutMs(
    args["timeout-ms"] ?? process.env.EVAL_REQUEST_TIMEOUT_MS,
  );

  const scenarios = await loadScenarios(
    GOLDEN_DIR,
    typeof args.filter === "string" ? args.filter : undefined,
  );
  if (scenarios.length === 0) {
    console.log("No scenarios matched.");
    return;
  }

  // prompt 版本追溯：harness 生产 lane 的 prompt 本体是 SDK 指令常量，取其内容哈希前 6 位。
  const promptVersion = `harness-${createHash("sha256")
    .update(CUSTOMER_SERVICE_SDK_INSTRUCTIONS)
    .digest("hex")
    .slice(0, 6)}`;

  console.log(
    `Running ${scenarios.length} scenario(s) × ${repeat} repeat, concurrency=${concurrency}, timeoutMs=${requestTimeoutMs}, promptVersion=${promptVersion}`,
  );
  console.log(`Tmp store dir: ${TMP_DIR}\n`);

  const runs: ScenarioResult[][] = [];
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) process.stdout.write(`  run ${i + 1}/${repeat} ...`);
    const r = await runAllScenarios(scenarios, concurrency, requestTimeoutMs);
    runs.push(r);
    if (repeat > 1)
      process.stdout.write(
        ` done (${r.filter((x) => x.passed).length}/${r.length} pass)\n`,
      );
  }

  const results = aggregateRuns(scenarios, runs);
  printReport(results);

  if (typeof args.save === "string") {
    await saveReport(args.save, results, promptVersion);
  }
  if (typeof args.baseline === "string") {
    await compareBaseline(args.baseline, results);
  }

  const anyFail = results.some((r) => !r.passed);
  process.exit(anyFail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
