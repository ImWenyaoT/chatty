import type { ChatCompletionsAdapter } from '@rental/llm'
import type { JsonValue } from '@rental/shared'

/**
 * Coarse routing decision for the incoming user message, decided BEFORE any
 * RAG/legacy answer. This is the fix for the PRD §9 pain point: the legacy
 * answerQuestion() runs knowledge search unconditionally; the new loop only
 * consults the legacy capability when classifyAction() says it is needed.
 *
 *   small_talk   -> reply directly, no RAG, no tools
 *   ask_info     -> needs the legacy answer / RAG path (price, size, policy...)
 *   provide_info -> user is feeding facts (date/size/height); acknowledge, no RAG
 *   handoff      -> human escalation requested
 */
export type ActionClass = 'small_talk' | 'ask_info' | 'provide_info' | 'handoff'

export interface ActionClassification {
  actionClass: ActionClass
  /** Short explanation, captured into the trace for human review. */
  reason: string
  /** Optional canned reply for non-answer classes (small_talk / provide_info). */
  reply?: string
}

interface ClassifierOutput {
  actionClass: ActionClass
  reason: string
  reply?: string
}

const SYSTEM_PROMPT = `你是 Chatty 客服系统的意图路由器。只输出一个 JSON 对象，不要输出任何其它文字。
判断用户这一轮消息属于哪一类 action：
- small_talk: 寒暄、感谢、再见、简单确认（如"好的""谢谢""在吗"）。
- ask_info: 询问商品、价格、尺码、库存、租期、物流、图片、政策等需要事实/检索的问题。
- provide_info: 用户在主动提供档期、身高体重、件数、改信息等陈述事实。
- handoff: 用户要求转人工、投诉、退款、赔偿。
输出格式: {"actionClass": "<上面四者之一>", "reason": "<简短理由>", "reply": "<仅当 small_talk/provide_info 时给一句简短中文回复，其它类留空>"}`

const ALLOWED: ActionClass[] = ['small_talk', 'ask_info', 'provide_info', 'handoff']

/**
 * Classifies a user message into an action class via a single cheap LLM call.
 * Falls back to ask_info (the safe, knowledge-backed path) on any error so the
 * customer is never silently stuck.
 */
export async function classifyAction(
  llm: ChatCompletionsAdapter,
  question: string,
): Promise<ActionClassification> {
  const trimmed = question.trim()
  if (!trimmed) {
    return { actionClass: 'small_talk', reason: 'empty message', reply: '您好，请问有什么可以帮您？' }
  }

  let parsed: ClassifierOutput
  try {
    parsed = await llm.completeJson<ClassifierOutput>([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: trimmed },
    ])
  } catch (err) {
    return {
      actionClass: 'ask_info',
      reason: `classifier_error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const actionClass: ActionClass = ALLOWED.includes(parsed.actionClass) ? parsed.actionClass : 'ask_info'
  return {
    actionClass,
    reason: typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : `${actionClass} (no reason)`,
    reply: typeof parsed.reply === 'string' && parsed.reply ? parsed.reply : undefined,
  }
}

// Re-export so callers can avoid importing JsonValue from shared separately.
export type { JsonValue }
