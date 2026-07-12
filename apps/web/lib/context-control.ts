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

/** Estimates prompt tokens conservatively without provider-specific tokenization. */
export function estimateContextTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2);
}

/** Projects checkpoint and frequently-used long-term memory into the next bounded turn. */
export function projectContext(input: {
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

/** Creates a Claude-Code-style context checkpoint before the next model sample crosses the budget. */
export async function compactContextIfNeeded(input: {
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
  checkpointModel?: string;
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
      ? (input.checkpointModel ?? "injected-checkpoint-generator")
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
