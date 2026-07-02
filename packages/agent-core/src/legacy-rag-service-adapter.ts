import type { LegacyChatAnswer, LegacyChatInput } from '@rental/shared'

export interface LegacyRagService {
  answer(input: LegacyChatInput): Promise<LegacyChatAnswer>
}

export type LegacyAnswerQuestion = (input: LegacyChatInput) => Promise<LegacyChatAnswer>

/**
 * Wraps the current rag-service answerQuestion function without moving its business logic.
 */
export function createLegacyRagServiceAdapter(
  answerQuestion: LegacyAnswerQuestion,
): LegacyRagService {
  return {
    async answer(input: LegacyChatInput) {
      return answerQuestion(input)
    },
  }
}
