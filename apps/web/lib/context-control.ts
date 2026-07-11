import type { ControlPlaneRepository, ConversationCheckpoint, MemoryCandidate } from '@rental/db'
import {
  createAgentsSdkStructuredRunner,
  createDeepSeekAgentsModelFromEnv,
  readLlmEnv,
} from '@rental/llm'
import type { JsonValue, MemorySnapshot } from '@rental/shared'
import { z } from 'zod'

const checkpointSchema = z
  .object({
    currentGoal: z.string(),
    confirmedFacts: z.array(z.string()),
    decisions: z.array(z.string()),
    preferences: z.array(z.string()),
    workflowState: z.string(),
    unresolved: z.array(z.string()),
    references: z.array(z.string()),
  })
  .strict()

export type CheckpointSummary = z.infer<typeof checkpointSchema>

/** Estimates prompt tokens conservatively without provider-specific tokenization. */
export function estimateContextTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2)
}

/** Projects checkpoint and frequently-used long-term memory into the next bounded turn. */
export function projectContext(input: {
  snapshot: MemorySnapshot
  checkpoint?: ConversationCheckpoint
  memories: MemoryCandidate[]
}): MemorySnapshot {
  const selected = input.memories.filter((entry) => entry.status === 'promoted').slice(0, 8)
  return {
    ...input.snapshot,
    recentMessages: input.snapshot.recentMessages.slice(-6),
    customerMemory: {
      summary: input.snapshot.customerMemory ?? null,
      checkpoint: input.checkpoint?.summary ?? null,
      longTerm: selected.map((entry) => ({
        id: entry.id,
        category: entry.category,
        key: entry.key,
        value: entry.value,
      })),
    },
  }
}

/** Creates a Codex-style context checkpoint before the next model sample crosses the budget. */
export async function compactContextIfNeeded(input: {
  control: ControlPlaneRepository
  snapshot: MemorySnapshot
  conversationId: string
  throughTraceId: string
  checkpointId: string
  workflowState: string
  tokenLimit?: number
}): Promise<{ checkpoint?: ConversationCheckpoint; tokenBefore: number; triggered: boolean }> {
  const tokenBefore = estimateContextTokens(input.snapshot)
  const tokenLimit = input.tokenLimit ?? Number(process.env.CHATTY_COMPACT_TOKEN_LIMIT || 24_000)
  if (tokenBefore < tokenLimit) return { tokenBefore, triggered: false }

  try {
    const env = readLlmEnv()
    const runCompact = createAgentsSdkStructuredRunner({
      instructions:
        'You compact one Chatty conversation into a handoff checkpoint. Preserve goals, confirmed facts, decisions, preferences, workflow state, unresolved work, and references. Drop retries and raw tool noise.',
      input: JSON.stringify({ snapshot: input.snapshot, workflowState: input.workflowState }),
      model: createDeepSeekAgentsModelFromEnv(),
      modelName: env.chatModel,
      outputType: checkpointSchema,
      outputExample:
        '{"currentGoal":"...","confirmedFacts":[],"decisions":[],"preferences":[],"workflowState":"...","unresolved":[],"references":[]}',
      toolChoice: 'none',
      maxTurns: 1,
    })
    const summary = await runCompact()
    const tokenAfter = estimateContextTokens(summary)
    const checkpoint = input.control.saveCheckpoint({
      id: input.checkpointId,
      conversationId: input.conversationId,
      throughTraceId: input.throughTraceId,
      summary: summary as unknown as JsonValue,
      tokenBefore,
      tokenAfter,
      model: env.chatModel,
    })
    return { checkpoint, tokenBefore, triggered: true }
  } catch {
    return { tokenBefore, triggered: true }
  }
}
