import type {
  ControlPlaneRepository,
  ExtractedMemoryCandidate,
  TraceRepository,
} from "@rental/db";
import {
  createAgentsSdkStructuredRunner,
  createDeepSeekAgentsModelFromEnv,
  readLlmEnv,
} from "@rental/llm";
import type { JsonValue } from "@rental/shared";
import { z } from "zod";

const extractionSchema = z
  .object({
    conversationSummary: z.string(),
    memories: z.array(
      z
        .object({
          category: z.enum([
            "preference",
            "measurement",
            "delivery",
            "service_history",
          ]),
          key: z.string(),
          value: z.union([z.string(), z.number(), z.boolean()]),
          confidence: z.number().min(0).max(1),
          sensitivity: z.enum(["normal", "sensitive"]),
          sourceTraceId: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const consolidationSchema = z
  .object({
    globalSummary: z.string(),
    promotedIds: z.array(z.string()),
    prunedIds: z.array(z.string()),
  })
  .strict();

/** Extracts source-backed memory candidates from one cooled conversation rollout. */
export async function runMemoryExtraction(input: {
  traces: TraceRepository;
  sessionId: string;
  customerId: string;
  conversationId: string;
  productId: string;
  id: (prefix: string) => string;
  signal?: AbortSignal;
}): Promise<{
  conversationSummary: string;
  candidates: ExtractedMemoryCandidate[];
}> {
  const traces = input.traces.queryBySession(input.sessionId);
  if (traces.length === 0) return { conversationSummary: "", candidates: [] };
  const env = readLlmEnv();
  const runExtraction = createAgentsSdkStructuredRunner({
    instructions:
      "Extract only durable customer facts useful across rental conversations. Do not store secrets, payment data, temporary requests, or guesses. Every memory must cite a supplied trace ID. Return an empty memories array when nothing is worth retaining.",
    input: JSON.stringify(traces),
    model: createDeepSeekAgentsModelFromEnv(),
    modelName: env.chatModel,
    outputType: extractionSchema,
    outputExample: '{"conversationSummary":"...","memories":[]}',
    toolChoice: "none",
    maxTurns: 1,
    signal: input.signal,
  });
  const extracted = await runExtraction();
  const validTraceIds = new Set(traces.map((trace) => trace.id));
  const candidates = extracted.memories.flatMap((memory) => {
    if (
      !validTraceIds.has(memory.sourceTraceId) ||
      memory.sensitivity === "sensitive"
    )
      return [];
    return [
      {
        id: input.id("mem"),
        sourceTraceId: memory.sourceTraceId,
        category: memory.category,
        key: memory.key,
        value: memory.value as JsonValue,
        confidence: memory.confidence,
        sensitivity: memory.sensitivity,
      },
    ];
  });
  return { conversationSummary: extracted.conversationSummary, candidates };
}

/** Consolidates ranked cross-conversation candidates into the customer memory summary. */
export async function runMemoryConsolidation(input: {
  control: ControlPlaneRepository;
  customerId: string;
  signal?: AbortSignal;
}): Promise<{
  globalSummary: string;
  promotedIds: string[];
  prunedIds: string[];
}> {
  const candidates = input.control
    .listMemoryCandidates(input.customerId)
    .slice(0, 50);
  if (candidates.length === 0)
    return { globalSummary: "", promotedIds: [], prunedIds: [] };
  const env = readLlmEnv();
  const runConsolidation = createAgentsSdkStructuredRunner({
    instructions:
      "Consolidate durable customer memories. Prefer high-confidence, frequently used, recent, non-conflicting facts. Promote useful IDs and prune stale or superseded IDs.",
    input: JSON.stringify(candidates),
    model: createDeepSeekAgentsModelFromEnv(),
    modelName: env.chatModel,
    outputType: consolidationSchema,
    outputExample: '{"globalSummary":"...","promotedIds":[],"prunedIds":[]}',
    toolChoice: "none",
    maxTurns: 1,
    signal: input.signal,
  });
  const consolidated = await runConsolidation();
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const promotedIds = consolidated.promotedIds.filter((id) => allowed.has(id));
  const prunedIds = consolidated.prunedIds.filter((id) => allowed.has(id));
  return { globalSummary: consolidated.globalSummary, promotedIds, prunedIds };
}
