/**
 * Result of evaluating one agent reply. Field shape mirrors the legacy
 * evaluateCustomerServiceReply() (rag-service/src/rag.ts) so the legacy
 * evaluator can be wrapped behind this interface without remapping.
 *
 * Declared locally in agent-core (not imported from rag-service) so the
 * package boundary stays clean; legacy wiring happens in apps/web.
 */
export interface EvaluationResult {
  score: number
  issues: string[]
  suggestions: string[]
  suggestedReply?: string
  evaluatorModel: string
  promptVersion: string
}

/** A single message in the history handed to the evaluator. */
export interface EvaluationMessage {
  role: string
  content: string
}

/**
 * Boundary around reply evaluation. Implemented by wrapping the legacy
 * evaluateCustomerServiceReply() (apps/web/lib/legacy-adapter) or any other
 * scoring strategy. agent-core depends on this interface, never on rag-service.
 */
export interface Evaluator {
  evaluate(history: EvaluationMessage[], reply: string): Promise<EvaluationResult>
}

export type EvaluateFunction = Evaluator['evaluate']

/**
 * Wraps a plain evaluate function as an Evaluator, so the legacy evaluator can
 * be wired in apps/web/lib/legacy-adapter without agent-core importing
 * rag-service.
 */
export function createEvaluator(evaluate: EvaluateFunction): Evaluator {
  return { evaluate }
}

/**
 * Coerces an arbitrary recentMessages value (JsonValue[] from SQLite or the
 * legacy JSON store) into the {role, content} shape the evaluator expects.
 *
 * Only entries with string `role` and `content` survive; extra fields (legacy
 * `timestamp`) are dropped and malformed entries are skipped, so a stray shape
 * in the memory store can never feed the evaluator garbage. Returns [] for any
 * non-array input.
 */
export function normalizeEvalHistory(recentMessages: unknown): EvaluationMessage[] {
  if (!Array.isArray(recentMessages)) return []
  const out: EvaluationMessage[] = []
  for (const entry of recentMessages) {
    if (entry && typeof entry === 'object') {
      const { role, content } = entry as Record<string, unknown>
      if (typeof role === 'string' && typeof content === 'string') {
        out.push({ role, content })
      }
    }
  }
  return out
}
