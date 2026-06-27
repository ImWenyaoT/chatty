import { Agent, run, tool } from '@openai/agents'
import { z } from 'zod'
import type {
  AgentStepResult,
  AgentsSdkRunInput,
  AgentsSdkRunner,
  JsonValue,
  RuntimeTool,
  RuntimeToolCall,
} from '@rental/shared'

// Re-export the shared contracts so callers that previously imported them from
// @rental/llm still resolve. The canonical home is now @rental/shared.
export type {
  AgentsSdkRunInput,
  AgentsSdkRunner,
  AgentsSdkRunFunction,
} from '@rental/shared'

export interface CreateAgentsSdkRunnerOptions {
  /** OpenAI model name (e.g. 'gpt-4o-mini') resolved against the configured provider. */
  model: string
  /** Chatty agent name surfaced in SDK traces. */
  agentName?: string
  /** Cap SDK-internal turns so a single bounded request step is never exceeded (docs §5.1). */
  maxTurns?: number
}

/**
 * Loose parameter schema accepted by the SDK's tool(): an object that passes
 * any keys through. Chatty RuntimeTool validates input itself; this only
 * describes the shape to the model.
 */
const LOOSE_PARAMS = z.object({}).passthrough()

/**
 * Builds the execute() handler for an SDK-mapped tool, with a hard safety gate.
 *
 * Defense-in-depth: the loop-runner already withholds non-low-risk tools from
 * the SDK lane via its policy filter (createDefaultPolicy auto-allows low risk
 * only), but createAgentsSdkRunner is a public boundary a caller could hand a
 * higher-risk RuntimeTool directly. Anything above low risk — or any
 * approvalRequired tool — is therefore NEVER auto-executed here; a structured
 * refusal is returned instead so the model can react (e.g. route to a human)
 * without any side effect firing. This mirrors the loop-runner filter so both
 * layers withhold the same set (refund=high, handoff=medium).
 *
 * Exported so the gate can be unit-tested without driving a real SDK run().
 */
export function sdkToolExecute(rt: RuntimeTool): (args: unknown) => Promise<string> {
  return async (args) => {
    if (rt.approvalRequired || rt.risk !== 'low') {
      return {
        refused: true,
        reason: `tool ${rt.name} (risk=${rt.risk}) is not auto-runnable in the SDK lane; needs a human`,
      } as unknown as string
    }
    const result = await rt.execute((args ?? {}) as Record<string, JsonValue>)
    // SDK expects a serialisable return; JsonValue is already JSON-safe.
    return result as unknown as string
  }
}

/**
 * Maps a Chatty RuntimeTool onto an OpenAI Agents SDK function tool. The SDK
 * requires a schema to describe params to the model; we keep it loose and let
 * the Chatty tool's own execute() validate. Execution goes through
 * sdkToolExecute so the approval gate holds.
 */
function toSdkTool(rt: RuntimeTool) {
  return tool({
    name: rt.name,
    description: rt.description,
    parameters: LOOSE_PARAMS,
    execute: sdkToolExecute(rt),
  })
}

/**
 * Extracts the user question from a ConversationEvent payload, mirroring
 * loop-runner.readQuestion so the SDK run receives the same text. Exported for
 * unit testing the SDK lane's input mapping without a real API call.
 */
export function readQuestion(input: AgentsSdkRunInput): string {
  const payload = input.event.payload
  if (typeof payload === 'string') return payload
  const obj = payload as { question?: unknown } | null
  return typeof obj?.question === 'string' ? obj.question : ''
}

/**
 * Converts the SDK RunResult into a Chatty AgentStepResult. A handoff (the run
 * ended on a different agent than the entry agent) maps to handoff_and_wait;
 * otherwise the final text output becomes the reply. Exported for unit testing
 * the terminality mapping without driving a real run().
 */
export function toStepResult(input: AgentsSdkRunInput, finalOutput: unknown, handoffed: boolean): AgentStepResult {
  const traceId = input.event.traceId ?? input.event.eventId
  const text = typeof finalOutput === 'string' ? finalOutput : ''
  if (handoffed) {
    return {
      sessionId: input.event.conversationId,
      traceId,
      terminality: 'handoff_and_wait',
      reply: text || '好的，我帮您转接人工客服，请稍等。',
      toolCalls: [],
      nextStatus: 'waiting_for_human',
    }
  }
  return {
    sessionId: input.event.conversationId,
    traceId,
    terminality: 'reply_and_wait',
    reply: text,
    toolCalls: [],
    nextStatus: 'waiting_for_user',
  }
}

/**
 * Decides whether an SDK run ended in a handoff to a human. Two signals count:
 * the model called the escalate_to_human tool during the run, or the run ended
 * on a different agent than the entry agent (SDK-native handoff). Either means
 * handoff_and_wait. Pure + exported so the rule is unit-tested without a real run.
 */
export function isHandoff(
  escalated: boolean,
  lastAgentName: string | undefined,
  entryAgentName: string,
): boolean {
  if (escalated) return true
  return lastAgentName != null && lastAgentName !== entryAgentName
}

/**
 * Collects the RuntimeToolCall descriptors for the tools made available to the
 * run, so the trace records which capabilities were exposed. (Per-call detail
 * requires inspecting newItems; MVP records availability, not invocation.)
 */
function collectToolCalls(exposed: RuntimeTool[]): RuntimeToolCall[] {
  return exposed.map((t) => ({
    toolName: t.name,
    arguments: {},
    risk: t.risk,
    approvalRequired: t.approvalRequired,
  }))
}

/**
 * Creates an AgentsSdkRunner that drives a real OpenAI Agents SDK Agent run.
 *
 * The runner is the only place @openai/agents is imported; product code in
 * agent-core depends on the shared AgentsSdkRunner boundary instead (docs
 * tech-stack §7: all model calls go through packages/llm adapters).
 */
export function createAgentsSdkRunner(options: CreateAgentsSdkRunnerOptions): AgentsSdkRunner {
  return {
    async run(input: AgentsSdkRunInput): Promise<AgentStepResult> {
      const question = readQuestion(input)
      const exposed = input.tools ?? []
      const agentName = options.agentName ?? 'ChattyAgent'

      // Always give the SDK agent a way to escalate to a human. Tool-calling is
      // the cross-provider baseline (SDK-native handoffs need a real OpenAI
      // endpoint), so this works even when the SDK lane targets DeepSeek. The
      // closure flag is read after the run to map onto handoff_and_wait.
      let escalation: { triggered: boolean; reason: string } = { triggered: false, reason: '' }
      const escalateTool = tool({
        name: 'escalate_to_human',
        description:
          '当你无法回答、问题超出租衣客服范围、或客户明确要求人工/投诉/退款时调用，转接人工客服。',
        parameters: z.object({ reason: z.string() }).passthrough(),
        async execute(args) {
          const reason = typeof (args as { reason?: unknown })?.reason === 'string'
            ? (args as { reason: string }).reason
            : ''
          escalation = { triggered: true, reason }
          return { ok: true, escalated: true } as unknown as string
        },
      })

      const agent = new Agent({
        name: agentName,
        instructions: input.instructions,
        model: options.model,
        tools: [...exposed.map(toSdkTool), escalateTool],
      })

      const result = await run(agent, question, {
        maxTurns: options.maxTurns ?? 3,
      })

      const handoffed = isHandoff(escalation.triggered, result.lastAgent?.name, agentName)
      const stepResult = toStepResult(input, result.finalOutput, handoffed)
      stepResult.toolCalls = collectToolCalls(exposed)
      if (escalation.triggered) {
        // Surface why the bot escalated so the human agent has context (PRD §15).
        stepResult.memoryPatch = { handoffReason: escalation.reason } as unknown as JsonValue
      }
      return stepResult
    },
  }
}

/**
 * Thin wrapper that lets a caller inject a custom run function (tests). Mirrors
 * the legacy createLegacyRagServiceAdapter injection pattern.
 */
export function createAgentsSdkRunnerFromFunction(
  runFn: (input: AgentsSdkRunInput) => Promise<AgentStepResult>,
): AgentsSdkRunner {
  return { run: runFn }
}
