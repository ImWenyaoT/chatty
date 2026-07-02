// 金标回归测试运行器。
// 用法：
//   pnpm eval                                    # 跑全部场景
//   pnpm eval -- --filter happy-path             # 只跑匹配的场景
//   pnpm eval -- --save v1                       # 跑完把结果存到 tests/reports/v1.json
//   pnpm eval -- --baseline v1                   # 跑完和 tests/reports/v1.json 对比
//
// 注意：eval 会覆盖写入 tests/.tmp/memory-store.json 作为隔离的记忆库，
//       不会污染 data/memory-store.json。

// ⚠️ 必须是第一条 import：在 src/config 被求值前把 MEMORY_STORE_PATH 设好，
// 否则 ESM import 提升会让 config 先拿到默认值 data/，eval 误写生产库且隔离失效。
import './eval-env.js'

import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import {
  appendConversationMemory,
  flushPendingReviews,
  getProductMemory,
} from '../src/memory-store.js'
import { loaded } from '../src/prompts-loader.js'
import { answerQuestion } from '../src/rag.js'

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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const GOLDEN_DIR = path.join(ROOT, 'tests', 'golden')
const REPORTS_DIR = path.join(ROOT, 'tests', 'reports')
const TMP_MEMORY = path.join(ROOT, 'tests', '.tmp', 'memory-store.json')

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

async function loadScenarios(filter?: string): Promise<Scenario[]> {
  const entries = await fs.readdir(GOLDEN_DIR)
  const files = entries.filter((name) => /\.ya?ml$/i.test(name))
  const scenarios: Scenario[] = []
  for (const file of files) {
    const raw = await fs.readFile(path.join(GOLDEN_DIR, file), 'utf8')
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

function checkProfile(
  profile: ReturnType<typeof getProductMemory> extends Promise<infer T> ? T : never,
  expect: ExpectProfile,
): string[] {
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

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const stepResults: StepResult[] = []

  for (const step of scenario.steps) {
    const failures: string[] = []
    const result = await answerQuestion({
      customerId: scenario.customerId,
      productId: scenario.productId,
      conversationId: scenario.conversationId,
      question: step.user,
    })
    await appendConversationMemory({
      customerId: scenario.customerId,
      productId: scenario.productId,
      conversationId: scenario.conversationId,
      question: step.user,
      answer: result.answer,
    })

    const expect = step.expect ?? {}
    if (expect.contains) {
      for (const needle of expect.contains) {
        if (!result.answer.includes(needle)) {
          failures.push(`contains "${needle}" not found in answer`)
        }
      }
    }
    if (expect.containsAny) {
      if (!expect.containsAny.some((needle) => result.answer.includes(needle))) {
        failures.push(`containsAny [${expect.containsAny.join(', ')}] none found in answer`)
      }
    }
    if (expect.notSameAsPrev) {
      const prevAnswer = stepResults[stepResults.length - 1]?.answer
      if (prevAnswer !== undefined && result.answer.trim() === prevAnswer.trim()) {
        failures.push('notSameAsPrev: 本轮回复与上一轮逐字相同（机器人复读）')
      }
    }
    if (expect.notContains) {
      for (const needle of expect.notContains) {
        if (result.answer.includes(needle)) {
          failures.push(`notContains "${needle}" unexpectedly present`)
        }
      }
    }

    const pm = await getProductMemory(
      scenario.customerId,
      scenario.productId,
      scenario.conversationId,
    )
    const stage = pm?.conversationProfile?.orchestration?.stage
    const action = (result as { action?: string }).action

    if (expect.stage && stage !== expect.stage) {
      failures.push(`stage expected=${expect.stage} got=${stage}`)
    }
    if (expect.stageIn && !expect.stageIn.includes(stage ?? '')) {
      failures.push(`stage expected one of [${expect.stageIn.join(', ')}] got=${stage}`)
    }
    if (expect.action && action !== expect.action) {
      failures.push(`action expected=${expect.action} got=${action}`)
    }
    if (expect.actionIn && !expect.actionIn.includes(action ?? '')) {
      failures.push(`action expected one of [${expect.actionIn.join(', ')}] got=${action}`)
    }
    if (expect.profile) {
      failures.push(...checkProfile(pm, expect.profile))
    }

    stepResults.push({
      user: step.user,
      answer: result.answer,
      action,
      stage,
      failures,
    })
  }

  // 等待异步评估完成
  await flushPendingReviews()
  const finalMemory = await getProductMemory(
    scenario.customerId,
    scenario.productId,
    scenario.conversationId,
  )
  const systemReviews = (finalMemory?.reviews ?? []).filter(
    (r) => r.source === 'system' && r.score > 0,
  )

  // 把每条 review 按顺序对应到 step（简化：按 evaluatedReply 匹配）
  for (const step of stepResults) {
    const review = systemReviews.find((r) => r.evaluatedReply === step.answer)
    if (review) {
      step.score = review.score
    }
  }

  // minScore 检查要在评估落盘后做
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

// 跑一整套场景一次（跑前清空隔离记忆库，保证各 run 互不污染）。
async function runAllScenarios(scenarios: Scenario[]): Promise<ScenarioResult[]> {
  await fs.rm(TMP_MEMORY, { force: true }).catch(() => undefined)
  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    try {
      results.push(await runScenario(scenario))
    } catch (error) {
      console.error(
        `    ${scenario.name} error: ${error instanceof Error ? error.message : String(error)}`,
      )
      results.push({
        name: scenario.name,
        description: scenario.description,
        passed: false,
        steps: [],
        avgScore: 0,
      })
    }
  }
  return results
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

async function saveReport(tag: string, results: ScenarioResult[]) {
  await fs.mkdir(REPORTS_DIR, { recursive: true })
  const file = path.join(REPORTS_DIR, `${tag}.json`)
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        promptVersion: loaded.promptVersion,
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
    console.warn(`baseline not found: ${file}`)
    return
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

  const scenarios = await loadScenarios(typeof args.filter === 'string' ? args.filter : undefined)
  if (scenarios.length === 0) {
    console.log('No scenarios matched.')
    return
  }

  console.log(
    `Running ${scenarios.length} scenario(s) × ${repeat} repeat against promptVersion=${loaded.promptVersion}`,
  )
  console.log(`Memory store: ${TMP_MEMORY}\n`)

  const runs: ScenarioResult[][] = []
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) process.stdout.write(`  run ${i + 1}/${repeat} ...`)
    const r = await runAllScenarios(scenarios)
    runs.push(r)
    if (repeat > 1)
      process.stdout.write(` done (${r.filter((x) => x.passed).length}/${r.length} pass)\n`)
  }

  const results = aggregateRuns(scenarios, runs)
  printReport(results)

  if (typeof args.save === 'string') {
    await saveReport(args.save, results)
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
