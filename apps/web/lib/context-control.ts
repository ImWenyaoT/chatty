import type {
  ControlPlaneRepository,
  ConversationCheckpoint,
  MemoryCandidate,
} from "@rental/db";
import {
  createAgentsSdkStructuredRunner,
  createDeepSeekAgentsModelFromEnv,
  readLlmEnv,
} from "@rental/llm";
import type { JsonValue, MemorySnapshot } from "@rental/shared";
import { z } from "zod";

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
  .strict();

type CheckpointSummary = z.infer<typeof checkpointSchema>;
export type CheckpointGenerator = (
  snapshot: MemorySnapshot,
) => Promise<CheckpointSummary>;
type ContextControlEvent = {
  type: "compacted" | "compaction_failed" | "context_built";
  payload: Record<string, JsonValue>;
};

const RAW_MESSAGE_REPLAY_LIMIT = 6;

/** Estimates prompt tokens conservatively without provider-specific tokenization. */
function estimateContextTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2);
}

/** Projects checkpoint and frequently-used long-term memory into the next bounded turn. */
function projectContext(input: {
  snapshot: MemorySnapshot;
  checkpoint?: ConversationCheckpoint;
  memories: MemoryCandidate[];
}): MemorySnapshot {
  const selected = input.memories
    .filter((entry) => entry.status === "promoted")
    .slice(0, 8);
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
  };
}

/**
 * Prepares the complete model-facing context for one Customer Service Turn.
 * The module owns replay slicing, trace-boundary selection, checkpointing,
 * reprojection, and the observable events emitted by the caller.
 */
export async function prepareTurnContext(input: {
  control: ControlPlaneRepository;
  snapshot: MemorySnapshot;
  checkpoint?: ConversationCheckpoint;
  traceIds: readonly string[];
  conversationId: string;
  checkpointId: string;
  workflowState: string;
  memories: MemoryCandidate[];
  tokenLimit?: number;
  generateCheckpoint?: CheckpointGenerator;
}): Promise<{
  snapshot: MemorySnapshot;
  checkpoint?: ConversationCheckpoint;
  tokenBefore: number;
  triggered: boolean;
  failureKind?: "boundary_unavailable" | "generation_or_save_failed";
  events: ContextControlEvent[];
}> {
  let snapshot = projectContext({
    snapshot: input.snapshot,
    checkpoint: input.checkpoint,
    memories: input.memories,
  });
  const replayTraceCount = Math.ceil(
    Math.min(input.snapshot.recentMessages.length, RAW_MESSAGE_REPLAY_LIMIT) /
      2,
  );
  const compacted = await compactContextIfNeeded({
    control: input.control,
    snapshot,
    projectionBaseSnapshot: input.snapshot,
    compactableSnapshot: {
      ...snapshot,
      recentMessages: input.snapshot.recentMessages.slice(
        0,
        -RAW_MESSAGE_REPLAY_LIMIT,
      ),
    },
    conversationId: input.conversationId,
    throughTraceId:
      input.snapshot.recentMessages.length > RAW_MESSAGE_REPLAY_LIMIT
        ? input.traceIds.at(-(replayTraceCount + 1))
        : undefined,
    checkpointId: input.checkpointId,
    workflowState: input.workflowState,
    memories: input.memories,
    tokenLimit: input.tokenLimit,
    generateCheckpoint: input.generateCheckpoint,
  });
  const events: ContextControlEvent[] = [];
  if (compacted.checkpoint) {
    snapshot = projectContext({
      snapshot: input.snapshot,
      checkpoint: compacted.checkpoint,
      memories: input.memories,
    });
    events.push({
      type: "compacted",
      payload: {
        checkpointId: compacted.checkpoint.id,
        tokenBefore: compacted.tokenBefore,
        tokenAfter: compacted.checkpoint.tokenAfter,
      },
    });
  } else if (compacted.failureKind) {
    events.push({
      type: "compaction_failed",
      payload: {
        failureKind: compacted.failureKind,
        checkpointVersion: input.checkpoint?.version ?? 0,
      },
    });
  }
  events.push({
    type: "context_built",
    payload: {
      estimatedTokens: compacted.tokenBefore,
      compactTriggered: compacted.triggered,
      checkpointVersion:
        compacted.checkpoint?.version ?? input.checkpoint?.version ?? 0,
      memoryIds: input.memories.map((memory) => memory.id),
    },
  });
  return { snapshot, events, ...compacted };
}

/** Creates a Claude-Code-style context checkpoint before the next model sample crosses the budget. */
async function compactContextIfNeeded(input: {
  control: ControlPlaneRepository;
  snapshot: MemorySnapshot;
  projectionBaseSnapshot?: MemorySnapshot;
  compactableSnapshot?: MemorySnapshot;
  conversationId: string;
  throughTraceId?: string;
  checkpointId: string;
  workflowState: string;
  memories?: MemoryCandidate[];
  tokenLimit?: number;
  generateCheckpoint?: CheckpointGenerator;
}): Promise<{
  checkpoint?: ConversationCheckpoint;
  tokenBefore: number;
  triggered: boolean;
  failureKind?: "boundary_unavailable" | "generation_or_save_failed";
}> {
  const tokenBefore = estimateContextTokens(input.snapshot);
  const tokenLimit =
    input.tokenLimit ??
    Number(process.env.CHATTY_COMPACT_TOKEN_LIMIT || 24_000);
  if (tokenBefore < tokenLimit) return { tokenBefore, triggered: false };
  if (!input.throughTraceId) {
    return {
      tokenBefore,
      triggered: true,
      failureKind: "boundary_unavailable",
    };
  }

  try {
    const modelName = input.generateCheckpoint
      ? "injected-checkpoint-generator"
      : readLlmEnv().chatModel;
    const runCompact =
      input.generateCheckpoint ?? createCheckpointGenerator(input, modelName);
    const summary = await runCompact(
      input.compactableSnapshot ?? input.snapshot,
    );
    const projected = projectContext({
      snapshot: input.projectionBaseSnapshot ?? input.snapshot,
      checkpoint: {
        id: input.checkpointId,
        conversationId: input.conversationId,
        throughTraceId: input.throughTraceId,
        version: 0,
        summary,
        tokenBefore,
        tokenAfter: 0,
        model: modelName,
        createdAt: "",
      },
      memories: input.memories ?? [],
    });
    const tokenAfter = estimateContextTokens(projected);
    const checkpoint = input.control.saveCheckpoint({
      id: input.checkpointId,
      conversationId: input.conversationId,
      throughTraceId: input.throughTraceId,
      summary: summary as unknown as JsonValue,
      tokenBefore,
      tokenAfter,
      model: modelName,
    });
    return { checkpoint, tokenBefore, triggered: true };
  } catch {
    return {
      tokenBefore,
      triggered: true,
      failureKind: "generation_or_save_failed",
    };
  }
}

/** Builds the production DeepSeek structured checkpoint generator. */
function createCheckpointGenerator(
  input: {
    snapshot: MemorySnapshot;
    compactableSnapshot?: MemorySnapshot;
    workflowState: string;
  },
  modelName: string,
): CheckpointGenerator {
  const runStructured = createAgentsSdkStructuredRunner({
    instructions:
      "You compact one Chatty conversation into a handoff checkpoint. Preserve goals, confirmed facts, decisions, preferences, workflow state, unresolved work, and references. Drop retries and raw tool noise.",
    input: JSON.stringify({
      snapshot: input.compactableSnapshot ?? input.snapshot,
      workflowState: input.workflowState,
    }),
    model: createDeepSeekAgentsModelFromEnv(),
    modelName,
    outputType: checkpointSchema,
    outputExample:
      '{"currentGoal":"...","confirmedFacts":[],"decisions":[],"preferences":[],"workflowState":"...","unresolved":[],"references":[]}',
    toolChoice: "none",
    maxTurns: 1,
  });
  return async () => runStructured();
}
