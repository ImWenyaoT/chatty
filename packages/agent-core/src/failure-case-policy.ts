import type { AgentTrace, JsonValue } from '@rental/shared'
import type { EvaluationResult } from './evaluator.js'

/**
 * A failure-case candidate derived from a low-scoring trace (PRD §13). This is
 * the agent-core-side shape; the web layer maps it onto db.NewFailureCase (which
 * adds an id) so agent-core does not depend on packages/db.
 */
export interface FailureCaseCandidate {
  traceId: string
  sessionId: string
  score: number
  issues: string[]
  input: JsonValue
  output?: JsonValue
}

/** Default threshold below which a trace becomes a failure-case candidate. */
export const DEFAULT_FAILURE_SCORE_THRESHOLD = 6

/**
 * Decides whether an evaluation score is low enough to create a failure case.
 * PRD §13: "Evaluator low score -> creates failure_case".
 */
export function shouldCreateFailureCase(
  score: number,
  threshold: number = DEFAULT_FAILURE_SCORE_THRESHOLD,
): boolean {
  return score < threshold
}

/**
 * Derives a failure-case candidate from a trace and its evaluation. Pure: no id
 * generation or timestamps; the caller (web layer + repository) supplies those.
 */
export function deriveFailureCase(
  trace: AgentTrace,
  review: EvaluationResult,
): FailureCaseCandidate {
  return {
    traceId: trace.id,
    sessionId: trace.sessionId,
    score: review.score,
    issues: review.issues,
    input: trace.input,
    output: trace.output,
  }
}
