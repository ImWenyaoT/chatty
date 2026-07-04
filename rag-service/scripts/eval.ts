// 金标回归测试运行器（双目标，docs/agentic-search-design.md §5）。
// 用法：
//   pnpm eval                                    # legacy lane：跑全部场景
//   pnpm eval -- --target harness                # harness lane：进程内直调 harness 步
//   pnpm eval -- --filter happy-path             # 只跑匹配的场景
//   pnpm eval -- --save v1                       # 跑完把结果存到 tests/reports/v1.json
//   pnpm eval -- --baseline v1                   # 跑完和 tests/reports/v1.json 对比
//
// 双目标（§5.1 E1）：被测面抽象为 sendTurn(target, scenario, question)，
//   --target legacy  : 现有 answerQuestion 进程内直调（原路径不动），场景在 tests/golden/，
//                      评分沿用 memory-store 异步评估 + flush 后按 evaluatedReply 回填；
//   --target harness : runCustomerServiceHarnessStep 进程内直调（复刻 route.ts 步骤
//                      2→4→5b，去 HTTP/auth/trace 持久化），场景在 tests/golden-harness/，
//                      每场景独立 tmp SQLite（§5.2），judge 由 runner 同步调用回填分数。
//                      需先 pnpm build:skeleton（@rental/* 从 dist 解析）。
//
// 注意：legacy lane 会覆盖写入 tests/.tmp/memory-store.json 作为隔离的记忆库，
//       不会污染 data/memory-store.json；harness lane 的 tmp SQLite 也在 tests/.tmp/。

// ⚠️ 必须是第一条 import：在 src/config 被求值前把 MEMORY_STORE_PATH 设好，
// 否则 ESM import 提升会让 config 先拿到默认值 data/，eval 误写生产库且隔离失效。
import './eval-env.js'

import 'dotenv/config'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS,
  createDefaultToolRegistry,
  type CustomerServiceModelFn,
  type CustomerServiceToolLoopFn,
  runCustomerServiceHarnessStep,
  type ToolRegistry,
} from '@rental/agent-core'
import {
  createKnowledgeRepository,
  createMemoryRepository,
  type Db,
  type MemoryRepository,
  openDatabase,
  syncKnowledgeIndex,
} from '@rental/db'
import type { ConversationEvent } from '@rental/shared'
import { createChatCompletionsAdapterFromEnv, parseJsonObject, readLlmEnv } from '@rental/llm'
import YAML from 'yaml'
import {
  appendConversationMemory,
  flushPendingReviews,
  getProductMemory,
} from '../src/memory-store.js'
import { evaluateCustomerServiceReply } from '../src/evaluator.js'
import { loaded } from '../src/prompts-loader.js'
import { answerQuestion } from '../src/rag.js'

type EvalTarget = 'legacy' | 'harness'

interface ExpectProfile {
  heightCm?: number | '*'
  weightKg?: number | '*'
  rentalPeriod?: { startDate?: string | '*'; endDate?: string | '*' }
  productIntent?: { currentProductText?: string | '*' }
}

interface ExpectBlock {
  contains?: string[]
  /** OR 语义：answer 命中其中任意一个即可（用于"M 或 L"这类单值不可能同时出现的断言）。 */
  containsAny?: string[]
  notContains?: string[]
  /** 本轮回复不能和上一轮逐字相同（抓机器人复读，如连续 repair）。 */
  notSameAsPrev?: boolean
  minScore?: number
  stage?: string
  stageIn?: string[]
  profile?: ExpectProfile
  action?: string
  actionIn?: string[]
}

interface ScenarioStep {
  user: string
  expect?: ExpectBlock
}

interface Scenario {
  name: string
  description?: string
  customerId: string
  productId?: string
  conversationId?: string
  steps: ScenarioStep[]
}

interface StepResult {
  user: string
  answer: string
  action?: string
  stage?: string
  score?: number
  failures: string[]
}

interface ScenarioResult {
  name: string
  description?: string
  passed: boolean
  steps: StepResult[]
  avgScore: number
  /** --repeat 聚合：N 次运行里通过的次数 */
  passCount?: number
  /** --repeat 聚合：总运行次数 */
  runCount?: number
  /** --repeat 聚合：每次运行的场景均分样本（用于看噪声幅度） */
  scoreSamples?: number[]
}

/** legacy lane 的 product memory（stage/profile 断言的取值来源）。 */
type LegacyProductMemory = Awaited<ReturnType<typeof getProductMemory>>

/** sendTurn 的统一回合结果（§5.1）：两条 lane 的被测面都收敛到这个形状。 */
interface TurnOutcome {
  answer: string
  action?: string
  taskKind?: string
  stage?: string
  memorySnapshot?: LegacyProductMemory
  score?: number
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const GOLDEN_DIRS: Record<EvalTarget, string> = {
  legacy: path.join(ROOT, 'tests', 'golden'),
  harness: path.join(ROOT, 'tests', 'golden-harness'),
}
const REPORTS_DIR = path.join(ROOT, 'tests', 'reports')
const TMP_DIR = path.join(ROOT, 'tests', '.tmp')
const TMP_MEMORY = path.join(TMP_DIR, 'memory-store.json')
// 知识语料在仓库根（B1 迁移后的唯一权威位置），harness lane 每场景库同步一次（I1 幂等）
const KNOWLEDGE_DIR = path.join(ROOT, '..', 'knowledge')

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = true
    }
  }
  return args
}

async function loadScenarios(goldenDir: string, filter?: string): Promise<Scenario[]> {
  const entries = await fs.readdir(goldenDir)
  const files = entries.filter((name) => /\.ya?ml$/i.test(name))
  const scenarios: Scenario[] = []
  for (const file of files) {
    const raw = await fs.readFile(path.join(goldenDir, file), 'utf8')
    const parsed = YAML.parse(raw) as Scenario
    if (!parsed?.name || !Array.isArray(parsed.steps)) {
      console.warn(`skip ${file}: missing name or steps`)
      continue
    }
    if (filter && !parsed.name.includes(filter)) continue
    scenarios.push(parsed)
  }
  return scenarios
}

function matchExpect(value: unknown, expected: unknown): boolean {
  if (expected === '*') return value !== undefined && value !== null
  return value === expected
}

function checkProfile(profile: LegacyProductMemory | undefined, expect: ExpectProfile): string[] {
  const failures: string[] = []
  const cp = profile?.conversationProfile
  if (!cp) {
    failures.push('无 conversationProfile')
    return failures
  }
  if (expect.heightCm !== undefined && !matchExpect(cp.heightCm, expect.heightCm)) {
    failures.push(`heightCm expected=${expect.heightCm} got=${cp.heightCm}`)
  }
  if (expect.weightKg !== undefined && !matchExpect(cp.weightKg, expect.weightKg)) {
    failures.push(`weightKg expected=${expect.weightKg} got=${cp.weightKg}`)
  }
  if (expect.rentalPeriod) {
    if (
      expect.rentalPeriod.startDate !== undefined &&
      !matchExpect(cp.rentalPeriod?.startDate, expect.rentalPeriod.startDate)
    ) {
      failures.push(
        `rentalPeriod.startDate expected=${expect.rentalPeriod.startDate} got=${cp.rentalPeriod?.startDate}`,
      )
    }
    if (
      expect.rentalPeriod.endDate !== undefined &&
      !matchExpect(cp.rentalPeriod?.endDate, expect.rentalPeriod.endDate)
    ) {
      failures.push(
        `rentalPeriod.endDate expected=${expect.rentalPeriod.endDate} got=${cp.rentalPeriod?.endDate}`,
      )
    }
  }
  if (
    expect.productIntent?.currentProductText !== undefined &&
    !matchExpect(cp.productIntent?.currentProductText, expect.productIntent.currentProductText)
  ) {
    failures.push(
      `productIntent.currentProductText expected=${expect.productIntent.currentProductText} got=${cp.productIntent?.currentProductText}`,
    )
  }
  return failures
}

/**
 * 单步断言检查（两 lane 共用）：行为断言（contains/containsAny/notContains/
 * notSameAsPrev/action）直接比对 TurnOutcome；stage/profile 是 legacy 实现词汇
 * （§5.3），harness 场景文件里出现即失败——防静默跳过，豁免走 YAML 里删除断言
 * 并落档 tests/golden-harness/README.md，而不是 runner 里悄悄放过。
 */
function checkExpectations(
  target: EvalTarget,
  expect: ExpectBlock,
  turn: TurnOutcome,
  prevAnswer?: string,
): string[] {
  const failures: string[] = []
  for (const needle of expect.contains ?? []) {
    if (!turn.answer.includes(needle)) failures.push(`contains "${needle}" not found in answer`)
  }
  if (expect.containsAny && !expect.containsAny.some((needle) => turn.answer.includes(needle))) {
    failures.push(`containsAny [${expect.containsAny.join(', ')}] none found in answer`)
  }
  if (
    expect.notSameAsPrev &&
    prevAnswer !== undefined &&
    turn.answer.trim() === prevAnswer.trim()
  ) {
    failures.push('notSameAsPrev: 本轮回复与上一轮逐字相同（机器人复读）')
  }
  for (const needle of expect.notContains ?? []) {
    if (turn.answer.includes(needle)) failures.push(`notContains "${needle}" unexpectedly present`)
  }
  if (target === 'harness' && (expect.stage || expect.stageIn || expect.profile)) {
    failures.push(
      'stage/profile 是 legacy 实现词汇，harness 场景不支持（design §5.3，豁免清单见 tests/golden-harness/README.md）',
    )
  }
  if (target === 'legacy') {
    if (expect.stage && turn.stage !== expect.stage) {
      failures.push(`stage expected=${expect.stage} got=${turn.stage}`)
    }
    if (expect.stageIn && !expect.stageIn.includes(turn.stage ?? '')) {
      failures.push(`stage expected one of [${expect.stageIn.join(', ')}] got=${turn.stage}`)
    }
  }
  if (expect.action && turn.action !== expect.action) {
    failures.push(`action expected=${expect.action} got=${turn.action}`)
  }
  if (expect.actionIn && !expect.actionIn.includes(turn.action ?? '')) {
    failures.push(`action expected one of [${expect.actionIn.join(', ')}] got=${turn.action}`)
  }
  if (target === 'legacy' && expect.profile) {
    failures.push(...checkProfile(turn.memorySnapshot, expect.profile))
  }
  return failures
}

/** harness lane 每场景会话状态：独立 tmp SQLite + 记忆 repo + 注入的模型调用（§5.2）。 */
interface HarnessSession {
  db: Db
  memory: MemoryRepository
  registry: ToolRegistry
  modelFn?: CustomerServiceModelFn
  toolLoopFn?: CustomerServiceToolLoopFn
  conversationId: string
  /** 本场景累积的对话（judge 的历史切片来源，口径同 legacy：含当前轮）。 */
  history: Array<{ role: string; content: string }>
  turn: number
}

/**
 * 构建 harness compose 的模型注入（语义与 apps/web/lib/llm.ts 的
 * createComposeModelFn/createComposeToolLoopFn 一致；eval 不跨包引 Next app
 * 内部文件，这里内联同款包装）：JSON 宽容解析后再字符串化，完全不可解析时
 * 抛错由 compose 落回确定性 composer。无 OPENAI_API_KEY 时返回空对象，
 * harness 落确定性 composer（报告里自然全 FAIL，不伪装成可评测）。
 */
function createHarnessModelFns(): {
  modelFn?: CustomerServiceModelFn
  toolLoopFn?: CustomerServiceToolLoopFn
} {
  if (!readLlmEnv().apiKey) return {}
  const adapter = createChatCompletionsAdapterFromEnv()
  return {
    modelFn: async (prompt) =>
      JSON.stringify(
        await adapter.completeJson<Record<string, unknown>>([
          { role: 'system', content: CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS },
          { role: 'user', content: prompt },
        ]),
      ),
    toolLoopFn: async (messages, tools) => {
      const reply = await adapter.completeWithTools(messages, tools)
      if ('toolCalls' in reply) return reply
      return { text: JSON.stringify(parseJsonObject<Record<string, unknown>>(reply.text)) }
    },
  }
}

/** 打开一个 harness 场景会话：删除重建独立 tmp SQLite，同步知识索引，装配 repos。 */
async function openHarnessSession(scenario: Scenario): Promise<HarnessSession> {
  const dbPath = path.join(TMP_DIR, `harness-${scenario.name}.sqlite`)
  await Promise.all(['', '-wal', '-shm'].map((suffix) => fs.rm(dbPath + suffix, { force: true })))
  const db = openDatabase(dbPath)
  if (existsSync(KNOWLEDGE_DIR)) syncKnowledgeIndex(db, KNOWLEDGE_DIR)
  return {
    db,
    memory: createMemoryRepository(db),
    registry: createDefaultToolRegistry(createKnowledgeRepository(db)),
    ...createHarnessModelFns(),
    conversationId:
      scenario.conversationId ?? `${scenario.customerId}:${scenario.productId ?? 'general'}`,
    history: [],
    turn: 0,
  }
}

/**
 * 被测面抽象（§5.1）：把一句用户消息发给指定 lane，返回统一的 TurnOutcome。
 * legacy 走现有 answerQuestion 直调（评分仍由 memory-store 异步评估、场景末
 * flush 后回填，原路径不动）；harness 进程内直调 harness 步（复刻 route.ts
 * 步骤 2→4→5b），judge 与 legacy 同一本体、由 runner 同步调用回填分数。
 */
async function sendTurn(
  target: EvalTarget,
  scenario: Scenario,
  question: string,
  session?: HarnessSession,
): Promise<TurnOutcome> {
  if (target === 'legacy') {
    const result = await answerQuestion({
      customerId: scenario.customerId,
      productId: scenario.productId,
      conversationId: scenario.conversationId,
      question,
    })
    await appendConversationMemory({
      customerId: scenario.customerId,
      productId: scenario.productId,
      conversationId: scenario.conversationId,
      question,
      answer: result.answer,
    })
    const pm = await getProductMemory(
      scenario.customerId,
      scenario.productId,
      scenario.conversationId,
    )
    return {
      answer: result.answer,
      action: (result as { action?: string }).action,
      stage: pm?.conversationProfile?.orchestration?.stage,
      memorySnapshot: pm,
    }
  }

  if (!session) throw new Error('harness lane 需要场景会话（openHarnessSession）')
  const event: ConversationEvent = {
    eventId: `eval-${scenario.name}-${session.turn++}`,
    type: 'user_message',
    customerId: scenario.customerId,
    conversationId: session.conversationId,
    productId: scenario.productId,
    source: 'customer',
    payload: { question },
    occurredAt: new Date().toISOString(),
  }
  const snapshot = session.memory.snapshot({
    customerId: scenario.customerId,
    conversationId: session.conversationId,
    productId: scenario.productId,
  })
  const harness = await runCustomerServiceHarnessStep({
    event,
    memory: snapshot,
    registry: session.registry,
    sessionStatus: 'active',
    modelFn: session.modelFn,
    toolLoopFn: session.toolLoopFn,
  })
  const answer = harness.step.reply ?? ''
  // route.ts 步骤 5b 同款连续性写入：只追加消息滑窗，不提升 profile 字段
  session.memory.appendRecentMessages(
    {
      customerId: scenario.customerId,
      productId: scenario.productId ?? 'general',
      conversationId: session.conversationId,
    },
    [
      { role: 'user', content: question },
      { role: 'assistant', content: answer },
    ],
  )
  session.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer })
  let score: number | undefined
  try {
    score = (await evaluateCustomerServiceReply(session.history.slice(-10), answer)).score
  } catch (error) {
    // judge 失败不吞错也不中断场景：留 undefined，minScore 断言会以"未拿到评分"失败
    console.error(`    judge error: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    answer,
    action: harness.trace.action.action,
    taskKind: harness.trace.task.kind,
    score,
  }
}

async function runScenario(scenario: Scenario, target: EvalTarget): Promise<ScenarioResult> {
  const session = target === 'harness' ? await openHarnessSession(scenario) : undefined
  const stepResults: StepResult[] = []

  try {
    for (const step of scenario.steps) {
      const turn = await sendTurn(target, scenario, step.user, session)
      const failures = checkExpectations(
        target,
        step.expect ?? {},
        turn,
        stepResults[stepResults.length - 1]?.answer,
      )
      stepResults.push({
        user: step.user,
        answer: turn.answer,
        action: turn.action,
        stage: turn.stage,
        score: turn.score,
        failures,
      })
    }
  } finally {
    session?.db.close()
  }

  if (target === 'legacy') {
    // 等待异步评估完成，把 review 按 evaluatedReply 匹配回填到 step（原路径保留到 R4）
    await flushPendingReviews()
    const finalMemory = await getProductMemory(
      scenario.customerId,
      scenario.productId,
      scenario.conversationId,
    )
    const systemReviews = (finalMemory?.reviews ?? []).filter(
      (r) => r.source === 'system' && r.score > 0,
    )
    for (const step of stepResults) {
      const review = systemReviews.find((r) => r.evaluatedReply === step.answer)
      if (review) {
        step.score = review.score
      }
    }
  }

  // minScore 检查要在评分就位后做（legacy：flush 回填；harness：sendTurn 已同步回填）
  for (let i = 0; i < scenario.steps.length; i++) {
    const minScore = scenario.steps[i].expect?.minScore
    if (minScore === undefined) continue
    const score = stepResults[i].score
    if (score === undefined) {
      stepResults[i].failures.push(`minScore=${minScore} 但未拿到评分（评估失败？）`)
    } else if (score < minScore) {
      stepResults[i].failures.push(`score=${score} < minScore=${minScore}`)
    }
  }

  const scores = stepResults.map((s) => s.score).filter((s): s is number => typeof s === 'number')
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
  const passed = stepResults.every((s) => s.failures.length === 0)

  return {
    name: scenario.name,
    description: scenario.description,
    passed,
    steps: stepResults,
    avgScore,
  }
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
  const results = new Array<R>(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

// 跑一整套场景一次（跑前清空隔离记忆库，保证各 run 互不污染）。
// harness 目标每场景用独立 tmp SQLite，可并发；legacy 目标共享 TMP_MEMORY，
// 必须串行（并发会互相污染记忆库）。瓶颈是 LLM inference，并发直接缩墙钟。
async function runAllScenarios(
  scenarios: Scenario[],
  target: EvalTarget,
  concurrency = 1,
): Promise<ScenarioResult[]> {
  await fs.rm(TMP_MEMORY, { force: true }).catch(() => undefined)
  const limit = target === 'harness' ? Math.max(1, concurrency) : 1
  return mapWithConcurrency(scenarios, limit, async (scenario) => {
    try {
      return await runScenario(scenario, target)
    } catch (error) {
      console.error(
        `    ${scenario.name} error: ${error instanceof Error ? error.message : String(error)}`,
      )
      return {
        name: scenario.name,
        description: scenario.description,
        passed: false,
        steps: [],
        avgScore: 0,
      }
    }
  })
}

// 把 N 次运行聚合成单份报告：avgScore 取均值、passed 记通过率，steps 取最后一次用于展示。
// 取均值是为了抵消 LLM 评分的随机噪声（实测可达 ±2），让 prompt 改动的真实信号显出来。
function aggregateRuns(scenarios: Scenario[], runs: ScenarioResult[][]): ScenarioResult[] {
  return scenarios.map((scenario) => {
    const perRun = runs
      .map((r) => r.find((x) => x.name === scenario.name))
      .filter((x): x is ScenarioResult => !!x)
    const scoreSamples = perRun.map((r) => r.avgScore)
    const avgScore = scoreSamples.length
      ? scoreSamples.reduce((a, b) => a + b, 0) / scoreSamples.length
      : 0
    const passCount = perRun.filter((r) => r.passed).length
    const last = perRun[perRun.length - 1]
    return {
      name: scenario.name,
      description: scenario.description,
      passed: passCount === perRun.length && perRun.length > 0, // 全过才算稳定通过
      steps: last?.steps ?? [],
      avgScore,
      passCount,
      runCount: perRun.length,
      scoreSamples,
    }
  })
}

function printReport(results: ScenarioResult[]) {
  console.log('\n========== Eval Report ==========')
  for (const r of results) {
    const stable = (r.runCount ?? 1) > 1
    const passText = stable ? `pass ${r.passCount}/${r.runCount}` : r.passed ? 'PASS' : 'FAIL'
    const badge = r.passed ? '✅' : (r.passCount ?? 0) > 0 ? '🟡' : '❌'
    const sampleText =
      stable && r.scoreSamples ? ` [${r.scoreSamples.map((s) => s.toFixed(1)).join('/')}]` : ''
    console.log(
      `\n${badge} ${passText}  ${r.name}  (avgScore=${r.avgScore.toFixed(2)})${sampleText}`,
    )
    if (r.description) console.log(`        ${r.description}`)
    for (const step of r.steps) {
      const scoreText = step.score !== undefined ? ` [${step.score}/10]` : ''
      const actionText = step.action ? ` {${step.action}}` : ''
      console.log(`   > user: ${step.user}${scoreText}${actionText}`)
      console.log(`     ans : ${step.answer.slice(0, 80)}${step.answer.length > 80 ? '…' : ''}`)
      for (const f of step.failures) {
        console.log(`     ✗  ${f}`)
      }
    }
  }
  const passed = results.filter((r) => r.passed).length
  console.log(`\n=================================`)
  console.log(`Total: ${passed}/${results.length} passed`)
  console.log(`=================================\n`)
}

async function saveReport(tag: string, results: ScenarioResult[], promptVersion: string) {
  await fs.mkdir(REPORTS_DIR, { recursive: true })
  const file = path.join(REPORTS_DIR, `${tag}.json`)
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
    'utf8',
  )
  console.log(`Saved report -> ${file}`)
}

async function compareBaseline(baselineTag: string, results: ScenarioResult[]) {
  const file = path.join(REPORTS_DIR, `${baselineTag}.json`)
  let baseline: { promptVersion: string; results: ScenarioResult[] }
  try {
    baseline = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    console.error(
      `baseline not found: ${file} — 传了 --baseline 却读不到基线文件，拒绝静默跳过对比`,
    )
    process.exit(1)
  }

  console.log(`\n========== Compare vs ${baselineTag} (${baseline.promptVersion}) ==========`)
  for (const current of results) {
    const prev = baseline.results.find((r) => r.name === current.name)
    if (!prev) {
      console.log(`  NEW     ${current.name}  avgScore=${current.avgScore.toFixed(2)}`)
      continue
    }
    const delta = current.avgScore - prev.avgScore
    const arrow = delta > 0.05 ? '↑' : delta < -0.05 ? '↓' : '→'
    const passChange =
      prev.passed !== current.passed ? (current.passed ? ' [PASS regained]' : ' [PASS lost]') : ''
    console.log(
      `  ${arrow}   ${current.name}  ${prev.avgScore.toFixed(2)} -> ${current.avgScore.toFixed(2)} (Δ${delta.toFixed(2)})${passChange}`,
    )
  }
  console.log('')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repeat = Math.max(1, Number(args.repeat ?? 1) || 1)
  // 场景并发数（仅 harness 目标生效）。默认 6，兼顾墙钟与 DeepSeek 速率限制。
  const concurrency = Math.max(1, Number(args.concurrency ?? 6) || 6)
  const target = (args.target ?? 'legacy') as EvalTarget
  if (target !== 'legacy' && target !== 'harness') {
    console.error(`unknown --target ${String(args.target)}（只支持 legacy | harness）`)
    process.exit(1)
  }

  const scenarios = await loadScenarios(
    GOLDEN_DIRS[target],
    typeof args.filter === 'string' ? args.filter : undefined,
  )
  if (scenarios.length === 0) {
    console.log('No scenarios matched.')
    return
  }

  // prompt 版本追溯（§5.1 零成本移植）：legacy 用 prompts-loader 哈希；
  // harness 的 prompt 本体是 compose 指令常量，取其内容哈希前 6 位。
  const promptVersion =
    target === 'harness'
      ? `harness-${createHash('sha256').update(CUSTOMER_SERVICE_COMPOSE_INSTRUCTIONS).digest('hex').slice(0, 6)}`
      : loaded.promptVersion

  const parallelNote = target === 'harness' ? `, concurrency=${concurrency}` : ' (legacy: serial)'
  console.log(
    `Running ${scenarios.length} scenario(s) × ${repeat} repeat, target=${target}${parallelNote}, promptVersion=${promptVersion}`,
  )
  console.log(`Tmp store dir: ${TMP_DIR}\n`)

  const runs: ScenarioResult[][] = []
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) process.stdout.write(`  run ${i + 1}/${repeat} ...`)
    const r = await runAllScenarios(scenarios, target, concurrency)
    runs.push(r)
    if (repeat > 1)
      process.stdout.write(` done (${r.filter((x) => x.passed).length}/${r.length} pass)\n`)
  }

  const results = aggregateRuns(scenarios, runs)
  printReport(results)

  if (typeof args.save === 'string') {
    await saveReport(args.save, results, promptVersion)
  }
  if (typeof args.baseline === 'string') {
    await compareBaseline(args.baseline, results)
  }

  const anyFail = results.some((r) => !r.passed)
  process.exit(anyFail ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
