import { z } from 'zod'
import type { JsonValue } from './types.js'

export const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

export const conversationEventTypeSchema = z.enum([
  'user_message',
  'agent_reply_sent',
  'tool_result',
  'scheduled_followup_due',
  'human_handoff_requested',
  'human_agent_replied',
  'order_status_changed',
  'evaluation_failed',
  'knowledge_updated',
])

export const agentSessionStatusSchema = z.enum([
  'active',
  'waiting_for_user',
  'waiting_for_tool',
  'waiting_for_human',
  'paused',
  'closed',
  'failed',
])

export const runtimeToolRiskSchema = z.enum(['low', 'medium', 'high'])

export const conversationEventSchema = z.object({
  eventId: z.string().min(1),
  type: conversationEventTypeSchema,
  customerId: z.string().min(1),
  conversationId: z.string().min(1),
  productId: z.string().min(1).optional(),
  source: z.enum(['customer', 'agent', 'human', 'system', 'tool']),
  payload: jsonValueSchema,
  occurredAt: z.string().min(1),
  traceId: z.string().min(1).optional(),
})

export const agentSessionSchema = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  conversationId: z.string().min(1),
  productId: z.string().min(1).optional(),
  status: agentSessionStatusSchema,
  currentStep: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export const runtimeToolCallSchema = z.object({
  toolName: z.string().min(1),
  arguments: z.record(z.string(), jsonValueSchema),
  risk: runtimeToolRiskSchema,
  approvalRequired: z.boolean(),
})

export const agentStepResultSchema = z.object({
  sessionId: z.string().min(1),
  traceId: z.string().min(1),
  terminality: z.enum([
    'reply_and_wait',
    'tool_then_continue',
    'schedule_and_wait',
    'handoff_and_wait',
    'close',
  ]),
  reply: z.string().optional(),
  toolCalls: z.array(runtimeToolCallSchema),
  nextStatus: agentSessionStatusSchema,
  memoryPatch: jsonValueSchema.optional(),
})

export const legacyChatInputSchema = z.object({
  customerId: z.string().min(1),
  productId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  question: z.string().min(0),
  imageUrl: z.string().min(1).optional(),
  sessionContext: z.record(z.string(), jsonPrimitiveSchema).optional(),
  stylistPrompt: z.string().min(1).optional(),
})
