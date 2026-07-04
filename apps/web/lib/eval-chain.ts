import {
  deriveFailureCase,
  shouldCreateFailureCase,
  type EvaluationMessage,
  type Evaluator,
} from '@rental/agent-core'
import type { AgentTrace, JsonValue } from '@rental/shared'
import type { FailureCaseRepository, TraceRepository, TraceReviewRepository } from '@rental/db'
import { newId } from './db'

// 评测飞轮前半段（PRD §10/§13）：trace → LLM-judge review → 低分晋升 failure_case。
// playground 路由在 trace 落库后 fire-and-forget 调 scheduleTraceEvaluation；
// 后半段（promote CLI → golden 回归）见 scripts/promote-failure-case.mts。

/** 每次评测顺带补评的积压 trace 上限，控制单请求的 judge 调用量。 */
const BACKFILL_LIMIT = 2

/** 评测链路写入的三个仓储面（结构化子集，@rental/db 的实现直接满足）。 */
export interface EvalRepos {
  traces: Pick<TraceRepository, 'findUnevaluated'>
  reviews: Pick<TraceReviewRepository, 'append'>
  failures: Pick<FailureCaseRepository, 'create'>
}

/** 一次评测的目标：刚落库的 trace、评测用对话历史、被评的客服回复。 */
export interface EvalTarget {
  trace: AgentTrace
  history: EvaluationMessage[]
  reply: string
}

/** 测试注入点：替换 evaluator 加载与 key 探测，默认走 legacy adapter + env。 */
export interface EvalOptions {
  loadEvaluator?: () => Promise<Evaluator | undefined>
  hasEvaluatorKey?: () => boolean
}

export interface EvalChainResult {
  status: 'evaluated' | 'skipped_no_key' | 'skipped_no_evaluator'
  reviewed: number
  failures: number
}

/**
 * 默认 key 探测：legacy evaluator 走 OpenAI 兼容端点（DeepSeek 等通过
 * OPENAI_BASE_URL 映射），只依赖 OPENAI_API_KEY 一个开关。
 */
function defaultHasEvaluatorKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY)
}

/**
 * 默认加载器：懒 import legacy-adapter（其模块顶层引用 __dirname 等
 * Next 服务端专有环境），避免测试与非 Next 运行时在 import 阶段炸掉。
 */
async function defaultLoadEvaluator(): Promise<Evaluator | undefined> {
  const { loadLegacyEvaluator } = await import('./legacy-adapter')
  return loadLegacyEvaluator()
}

/**
 * 从已落库 trace 的 input/output JSON 还原评测入参（question → 单条 user
 * history，reply 为被评回复）。形状不符（如无 reply 的 handoff trace）返回
 * undefined，调用方跳过该条。
 */
function extractEvalPayload(
  trace: AgentTrace,
): { history: EvaluationMessage[]; reply: string } | undefined {
  const input = trace.input
  const output = trace.output
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const question = (input as Record<string, JsonValue>).question
  const reply = (output as Record<string, JsonValue>).reply
  if (typeof question !== 'string' || typeof reply !== 'string' || !reply) return undefined
  return { history: [{ role: 'user', content: question }], reply }
}

/**
 * 对单条 trace 跑 judge 并落库：review 追加进 trace_reviews；低分
 * （shouldCreateFailureCase，默认阈值 6）再晋升一条 failure_case。
 * 返回是否产生了 failure_case。
 */
async function evaluateOne(
  repos: EvalRepos,
  evaluator: Evaluator,
  target: EvalTarget,
): Promise<boolean> {
  const result = await evaluator.evaluate(target.history, target.reply)
  repos.reviews.append({
    id: newId('rev'),
    traceId: target.trace.id,
    score: result.score,
    issues: result.issues,
    suggestions: result.suggestions,
    suggestedReply: result.suggestedReply,
    evaluatorModel: result.evaluatorModel,
    promptVersion: result.promptVersion,
  })
  if (!shouldCreateFailureCase(result.score)) return false
  const candidate = deriveFailureCase(target.trace, result)
  repos.failures.create({ id: newId('fc'), ...candidate })
  return true
}

/**
 * 评测飞轮前半段主流程：先评当前 trace，再顺带补评最多 BACKFILL_LIMIT 条
 * 积压 trace（findUnevaluated，此刻已排除刚写完 review 的当前 trace）。
 * OPENAI_API_KEY 未配置或 evaluator 不可用（rag-service 未构建）时静默跳过，
 * 只记 debug 日志——绝不向上抛错。
 */
export async function runTraceEvaluation(
  repos: EvalRepos,
  target: EvalTarget,
  options: EvalOptions = {},
): Promise<EvalChainResult> {
  const hasKey = options.hasEvaluatorKey ?? defaultHasEvaluatorKey
  if (!hasKey()) {
    console.debug('[eval-chain] OPENAI_API_KEY 未配置，跳过异步评测')
    return { status: 'skipped_no_key', reviewed: 0, failures: 0 }
  }
  const evaluator = await (options.loadEvaluator ?? defaultLoadEvaluator)()
  if (!evaluator) {
    console.debug('[eval-chain] legacy evaluator 不可用（rag-service 未构建？），跳过异步评测')
    return { status: 'skipped_no_evaluator', reviewed: 0, failures: 0 }
  }

  let reviewed = 0
  let failures = 0
  if (await evaluateOne(repos, evaluator, target)) failures += 1
  reviewed += 1

  const backlog = repos.traces
    .findUnevaluated(BACKFILL_LIMIT + 1)
    .filter((trace) => trace.id !== target.trace.id)
    .slice(0, BACKFILL_LIMIT)
  for (const trace of backlog) {
    const payload = extractEvalPayload(trace)
    if (!payload) continue
    try {
      if (await evaluateOne(repos, evaluator, { trace, ...payload })) failures += 1
      reviewed += 1
    } catch (error) {
      console.error('[eval-chain] 补评积压 trace 失败（跳过该条）:', trace.id, error)
    }
  }
  return { status: 'evaluated', reviewed, failures }
}

/**
 * fire-and-forget 入口：不 await、错误只记日志，保证 playground 响应路径
 * 永远不被评测失败阻塞或拖垮。
 */
export function scheduleTraceEvaluation(
  repos: EvalRepos,
  target: EvalTarget,
  options?: EvalOptions,
): void {
  void runTraceEvaluation(repos, target, options).catch((error) => {
    console.error('[eval-chain] 异步评测失败（不影响已返回的回复）:', error)
  })
}
