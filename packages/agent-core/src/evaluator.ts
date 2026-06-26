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
 * Wraps a plain evaluate function as an Evaluator. Mirrors the
 * createLegacyRagServiceAdapter injection pattern so the legacy evaluator can be
 * wired without agent-core importing rag-service.
 */
export function createEvaluator(evaluate: EvaluateFunction): Evaluator {
  return { evaluate }
}
