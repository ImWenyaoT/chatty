export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ConversationEventType =
  | 'user_message'
  | 'agent_reply_sent'
  | 'tool_result'
  | 'scheduled_followup_due'
  | 'human_handoff_requested'
  | 'human_agent_replied'
  | 'order_status_changed'
  | 'evaluation_failed'
  | 'knowledge_updated'

export type AgentSessionStatus =
  | 'active'
  | 'waiting_for_user'
  | 'waiting_for_tool'
  | 'waiting_for_human'
  | 'paused'
  | 'closed'
  | 'failed'

export type AgentStepTerminality =
  'reply_and_wait' | 'tool_then_continue' | 'schedule_and_wait' | 'handoff_and_wait' | 'close'

export type RuntimeToolRisk = 'low' | 'medium' | 'high'

export interface ConversationEvent {
  eventId: string
  type: ConversationEventType
  customerId: string
  conversationId: string
  productId?: string
  source: 'customer' | 'agent' | 'human' | 'system' | 'tool'
  payload: JsonValue
  occurredAt: string
  traceId?: string
}

export interface AgentSession {
  id: string
  customerId: string
  conversationId: string
  productId?: string
  status: AgentSessionStatus
  currentStep: string
  createdAt: string
  updatedAt: string
}

export interface RuntimeToolCall {
  toolName: string
  arguments: Record<string, JsonValue>
  risk: RuntimeToolRisk
  approvalRequired: boolean
}

export interface AgentStepResult {
  sessionId: string
  traceId: string
  terminality: AgentStepTerminality
  reply?: string
  toolCalls: RuntimeToolCall[]
  nextStatus: AgentSessionStatus
  memoryPatch?: JsonValue
}

export interface AgentTrace {
  id: string
  sessionId: string
  eventType: ConversationEventType
  intent?: string
  action?: string
  input: JsonValue
  output?: JsonValue
  toolCalls: RuntimeToolCall[]
  references: JsonValue[]
  createdAt: string
}

export interface RuntimeTool<
  TInput extends Record<string, JsonValue> = Record<string, JsonValue>,
  TOutput extends JsonValue = JsonValue,
> {
  name: string
  description: string
  /** 入参 JSON Schema（对齐 Chat Completions function.parameters）；无参工具可省略。 */
  parameters?: Record<string, JsonValue>
  risk: RuntimeToolRisk
  approvalRequired: boolean
  execute(input: TInput, options?: { signal?: AbortSignal }): Promise<TOutput>
}

export interface MemorySnapshot {
  customerId: string
  conversationId: string
  productId?: string
  customerMemory?: JsonValue
  productMemory?: JsonValue
  recentMessages: JsonValue[]
}

export interface LegacyChatInput {
  customerId: string
  productId?: string
  conversationId?: string
  question: string
  imageUrl?: string
  sessionContext?: Record<string, JsonPrimitive>
}

export interface LegacyChatAnswer {
  answer: string
  action: string
  answerSource?: string
  references?: JsonValue[]
  imageReferences?: JsonValue[]
  handoff?: JsonValue
  intent?: JsonValue
  extractedFacts?: JsonValue
}
