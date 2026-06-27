import type { JsonValue } from '@rental/shared'

/**
 * A retrieved knowledge chunk. Payload shape mirrors the legacy
 * KnowledgeChunk (rag-service/src/types.ts): text + sourceType + contentType +
 * title, so the legacy searchKnowledge() result maps onto this directly.
 *
 * Kept in agent-core (not shared) because the knowledge vocabulary is a runtime
 * concept local to the agent loop (docs §9). `sourceType` and `contentType`
 * match the legacy PRD §14 retrieval-type taxonomy (FAQ/policy/product/media/history).
 */
export interface KnowledgeHit {
  /** Relevance score from the retriever (cosine similarity or qdrant score). */
  score: number
  /** The retrieved chunk; structure matches legacy KnowledgeChunk. */
  payload: JsonValue
}

/**
 * Retrieval query. MVP exposes free-text search; structured filters
 * (sourceType/contentType/productId) are forward-compatible additions.
 */
export interface KnowledgeQuery {
  question: string
  /** Optional cap on result count; the adapter applies its own default if unset. */
  topK?: number
  /** Optional filter by sourceType ('rule'|'history'|'product'). */
  sourceType?: string
}

/**
 * Boundary around knowledge/media retrieval (PRD §14). The legacy rag-service
 * searchKnowledge() is the first implementation, wrapped in apps/web; the loop
 * depends on this interface, never on qdrant or rag-service directly.
 *
 * Per docs loop-plan §3: prefer structured product lookup over vector search
 * when the question is about product/price/size/order. The loop's action
 * routing already does that (get_product tool); this adapter serves the
 * natural-language FAQ/policy ambiguity case.
 */
export interface KnowledgeAdapter {
  search(query: KnowledgeQuery): Promise<KnowledgeHit[]>
}

export type KnowledgeSearchFunction = KnowledgeAdapter['search']

/**
 * Wraps a plain search function as a KnowledgeAdapter. Mirrors the
 * createEvaluator / createLegacyRagServiceAdapter injection pattern so the
 * legacy searchKnowledge() can be wired without agent-core importing rag-service.
 */
export function createKnowledgeAdapter(search: KnowledgeSearchFunction): KnowledgeAdapter {
  return { search }
}
