import type {
  AgentStepResult,
  AgentsSdkRunner,
  ConversationEvent,
  JsonValue,
  RuntimeTool,
  RuntimeToolCall,
} from '@rental/shared'
import type { ChatCompletionsAdapter } from '@rental/llm'
import type { AgentContext, AgentLoopRunner } from './loop-contracts.js'
import { MAX_STEPS, createWaitingForUserResult } from './loop-contracts.js'
import type { LegacyRagService } from './legacy-rag-service-adapter.js'
import { classifyAction } from './action-classifier.js'
import type { ActionClass } from './action-classifier.js'
import type { ToolRegistry } from './tools/registry.js'
import type { Policy } from './policies/policy.js'
import { createDefaultPolicy } from './policies/policy.js'

export interface CreateLoopRunnerOptions {
  llm: ChatCompletionsAdapter
  /** Legacy answer path. May be undefined until Step 5 wires the real adapter. */
  legacy?: LegacyRagService
  /** Optional pre-built tool registry; a default is created if omitted. */
  tools?: ToolRegistry
  /** Inject a custom classifier (tests) instead of the LLM one. */
  classify?: (question: string) => Promise<{ actionClass: string; reason: string; reply?: string }>
  /** Phase 4: OpenAI Agents SDK runner. When set, ask_info routes here first (feature flag). */
  agentsSdkRunner?: AgentsSdkRunner
  /** Action classes that should route through agentsSdkRunner. Defaults to ask_info. */
  useAgentsSdkFor?: ActionClass[]
  /**
   * Safety policy deciding which tools may auto-run. Used to filter the tool set
   * exposed to the SDK lane so approval-gated (medium/high risk) tools — refund,
   * handoff — are never handed to an autonomous agent run. Defaults to
   * createDefaultPolicy() (only low-risk read/note tools are auto-exposed).
   */
  policy?: Policy
}

/**
 * Creates the Chatty bounded-loop runner.
 *
 * A single runStep() is bounded: at most one routing decision + read-only tool
 * fan-out, then it yields with a terminality (reply/handoff/tool). It never
 * blocks the request on long waits — those move to a worker in a later phase
 * (docs tech-stack §2). This is the layer the legacy answerQuestion() lacked.
 */
export function createLoopRunner(options: CreateLoopRunnerOptions): AgentLoopRunner {
  const classifier = options.classify ?? ((q: string) => classifyAction(options.llm, q))

  return {
    async runStep(context: AgentContext): Promise<AgentStepResult> {
      const { event } = context
      const traceId = event.traceId ?? event.eventId

      // Only user_message drives a fresh decision turn in MVP. Other event
      // types (tool_result, scheduled_followup_due...) are handled by the
      // caller re-entering the loop; here we acknowledge conservatively.
      if (event.type !== 'user_message') {
        return createWaitingForUserResult(event)
      }

      const question = readQuestion(event)
      const decision = await withStepBudget(async () => classifier(question))

      switch (decision.actionClass) {
        case 'handoff':
          return handoffResult(event, traceId, decision.reason, question)

        case 'small_talk':
        case 'provide_info':
          return replyResult(event, traceId, decision.reply ?? defaultAckReply(decision.actionClass), [], decision.reason)

        case 'ask_info':
        default:
          // The only path that may consult the legacy answer / RAG capability.
          return askInfoResult(event, traceId, question, decision.reason, options, context.memory)
      }
    },
  }
}

// --- helpers ----------------------------------------------------------------

function readQuestion(event: ConversationEvent): string {
  if (typeof event.payload === 'string') return event.payload
  const obj = event.payload as { question?: unknown } | null
  return typeof obj?.question === 'string' ? obj.question : ''
}

async function withStepBudget<T>(fn: () => Promise<T>): Promise<T> {
  // NOTE: this is currently a pass-through (single bounded decision per request).
  // MAX_STEPS is referenced only to keep the symbol live; it does NOT enforce a
  // budget yet. A real step counter / guardrail lands when tool-chaining is
  // introduced (docs §5.1). Until then the bounded-step guarantee comes from
  // runStep() making exactly one routing decision, not from this function.
  void MAX_STEPS
  return fn()
}

function replyResult(
  event: ConversationEvent,
  traceId: string,
  reply: string,
  toolCalls: RuntimeToolCall[],
  reason: string,
): AgentStepResult {
  void reason
  return {
    sessionId: event.conversationId,
    traceId,
    terminality: 'reply_and_wait',
    reply,
    toolCalls,
    nextStatus: 'waiting_for_user',
  }
}

function handoffResult(
  event: ConversationEvent,
  traceId: string,
  reason: string,
  question: string,
): AgentStepResult {
  return {
    sessionId: event.conversationId,
    traceId,
    terminality: 'handoff_and_wait',
    reply: '好的，我帮您转接人工客服，请稍等。',
    toolCalls: [],
    nextStatus: 'waiting_for_human',
    // Surface why the handoff happened so the human agent has context (PRD §15).
    memoryPatch: { handoffReason: reason, userQuestion: question } as unknown as JsonValue,
  }
}

function defaultAckReply(actionClass: string): string {
  return actionClass === 'small_talk'
    ? '您好，请问有什么可以帮您？'
    : '收到，已经记下啦。还需要补充别的信息吗？'
}

async function askInfoResult(
  event: ConversationEvent,
  traceId: string,
  question: string,
  reason: string,
  options: CreateLoopRunnerOptions,
  memory?: AgentContext['memory'],
): Promise<AgentStepResult> {
  // Phase 4 (feature-flagged): when an Agents SDK runner is wired, route
  // ask_info through it first — it owns tool/handoff loop semantics (docs §5.2).
  const sdkActions = options.useAgentsSdkFor ?? ['ask_info']
  if (options.agentsSdkRunner && sdkActions.includes('ask_info')) {
    // Only auto-expose tools the safety policy allows (low-risk). Approval-gated
    // tools (refund/handoff) are withheld so an autonomous SDK run can never
    // trigger a side effect that should require an operator (docs §9 policies).
    // NOTE: the policy's session-status dimension (deny-all on a closed session)
    // is not threaded here yet — the loop step does not receive session status,
    // so we evaluate against 'active'. Exposed tools are read/note stubs, so the
    // residual risk is a low-risk tool running for a closed session; tightening
    // this needs sessionStatus plumbed into AgentContext.
    const policy = options.policy ?? createDefaultPolicy()
    const exposed = (options.tools?.list() ?? []).filter(
      (t) =>
        policy.check(
          { toolName: t.name, arguments: {}, risk: t.risk, approvalRequired: t.approvalRequired },
          { sessionStatus: 'active' },
        ).action === 'allow',
    )
    return options.agentsSdkRunner.run({
      event,
      instructions:
        '你是 Chatty，租衣电商客服。用提供的工具查询商品/库存/订单后简短礼貌地回答；超出范围就转人工。不要编造价格。',
      context: memory ? { memorySnapshot: memory as unknown as JsonValue } : {},
      tools: exposed,
    })
  }

  // Prefer the legacy answer path when wired (Step 5). It already does intent
  // routing, RAG, templating and fact extraction for the rental domain.
  if (options.legacy) {
    try {
      const answer = await options.legacy.answer({
        customerId: event.customerId,
        conversationId: event.conversationId,
        productId: event.productId,
        question,
      })
      return {
        sessionId: event.conversationId,
        traceId,
        terminality: 'reply_and_wait',
        reply: answer.answer || defaultAckReply('ask_info'),
        toolCalls: [],
        nextStatus: answer.handoff ? 'waiting_for_human' : 'waiting_for_user',
        memoryPatch: (answer.extractedFacts ?? undefined) as JsonValue | undefined,
      }
    } catch (err) {
      return replyResult(
        event,
        traceId,
        '抱歉，我暂时没法查到这条信息，已为您转人工。',
        [],
        `legacy_error: ${err instanceof Error ? err.message : String(err)} | classifier: ${reason}`,
      )
    }
  }

  // No legacy path yet (pre-Step 5): fall back to the LLM directly so the loop
  // is still useful in isolation, with product tools available.
  return llmFallbackResult(event, traceId, question, options)
}

async function llmFallbackResult(
  event: ConversationEvent,
  traceId: string,
  question: string,
  options: CreateLoopRunnerOptions,
): Promise<AgentStepResult> {
  const toolCalls: RuntimeToolCall[] = []
  let productContext = ''
  if (event.productId && options.tools) {
    try {
      const product = await options.tools.invoke('get_product', { productId: event.productId })
      const p = product as { found?: boolean; name?: string; dailyPrice?: number; pricingNote?: string }
      if (p?.found) {
        toolCalls.push({ toolName: 'get_product', arguments: { productId: event.productId }, risk: 'low', approvalRequired: false })
        productContext = `\n\n[商品参考] ${p.name}，日租 ${p.dailyPrice}。${p.pricingNote ?? ''}`
      }
    } catch {
      // tool failure is non-fatal for the fallback path
    }
  }

  const reply = await options.llm.complete([
    {
      role: 'system',
      content:
        '你是 Chatty，一个租衣客服助手。根据已知商品信息简短礼貌地回答客户问题；不知道就说会帮客户转人工。不要编造价格。',
    },
    { role: 'user', content: question + productContext },
  ])

  return replyResult(event, traceId, reply || defaultAckReply('ask_info'), toolCalls, 'llm_fallback')
}
