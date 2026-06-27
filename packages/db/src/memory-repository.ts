import { readFileSync, existsSync } from 'node:fs'
import type { JsonValue } from '@rental/shared'
import type { Db } from './database.js'
import { nowIso } from './database.js'

/**
 * Memory repository: durable customer/product memory in SQLite JSON columns
 * (docs §6.3), with a read-only fallback to the legacy rag-service
 * `memory-store.json` so the new loop can read continuity without a migration.
 *
 * Write path is gated behind the CHATTY_SQLITE flag so legacy behaviour is
 * preserved while the SQLite write path is being proven.
 */
export interface MemoryRepository {
  getCustomer(customerId: string): CustomerMemoryRecord | undefined
  getProduct(customerId: string, productId: string, conversationId: string): ProductMemoryRecord | undefined
  /**
   * Loads a MemorySnapshot, preferring SQLite and falling back to the legacy
   * JSON store. Returns a minimal snapshot when nothing is known yet.
   */
  snapshot(input: SnapshotInput): MemorySnapshotRecord
  upsertCustomer(customerId: string, patch: Partial<CustomerMemoryRecord>): void
  upsertProduct(input: ProductMemoryInput, patch: Partial<ProductMemoryRecord>): void
  /**
   * Appends messages to a conversation's recentMessages and persists them,
   * capped to the most recent `cap` (default 20). This is the conservative
   * continuity write (docs §6.3 / chatty-memory-trace-migration): it touches
   * only the running message log — never customer profile fields, and it does
   * not promote transient RAG evidence into long-term memory.
   */
  appendRecentMessages(input: ProductMemoryInput, messages: JsonValue[], cap?: number): void
}

export interface CustomerMemoryRecord {
  customerId: string
  globalSummary: string
  sessionContext: JsonValue
  bodyProfiles: JsonValue
  updatedAt: string
}

export interface ProductMemoryRecord {
  conversationId: string
  customerId: string
  productId: string
  summary: string
  recentMessages: JsonValue
  conversationProfile: JsonValue
  reviews: JsonValue
  updatedAt: string
}

export interface ProductMemoryInput {
  conversationId: string
  customerId: string
  productId: string
}

export interface SnapshotInput {
  customerId: string
  conversationId: string
  productId?: string
}

export interface MemorySnapshotRecord {
  customerId: string
  conversationId: string
  productId?: string
  customerMemory?: JsonValue
  productMemory?: JsonValue
  recentMessages: JsonValue[]
}

export function createMemoryRepository(
  db: Db,
  options: { legacyMemoryPath?: string } = {},
): MemoryRepository {
  return {
    getCustomer(customerId) {
      const row = db
        .prepare('SELECT * FROM customer_memories WHERE customer_id = ?')
        .get(customerId) as CustomerRow | undefined
      return row ? parseCustomerRow(row) : undefined
    },

    getProduct(customerId, productId, conversationId) {
      // Prefer an exact conversation row; fall back to the latest for this
      // customer/product pair.
      const exact = db
        .prepare('SELECT * FROM product_memories WHERE conversation_id = ?')
        .get(conversationId) as ProductRow | undefined
      if (exact) return parseProductRow(exact)
      const byPair = db
        .prepare(
          'SELECT * FROM product_memories WHERE customer_id = ? AND product_id = ? ORDER BY updated_at DESC LIMIT 1',
        )
        .get(customerId, productId) as ProductRow | undefined
      return byPair ? parseProductRow(byPair) : undefined
    },

    snapshot(input) {
      const sqliteCustomer = this.getCustomer(input.customerId)
      const sqliteProduct = input.conversationId
        ? this.getProduct(input.customerId, input.productId ?? 'general', input.conversationId)
        : undefined

      if (sqliteCustomer || sqliteProduct) {
        return {
          customerId: input.customerId,
          conversationId: input.conversationId,
          productId: input.productId,
          customerMemory: sqliteCustomer ? (sqliteCustomer as unknown as JsonValue) : undefined,
          productMemory: sqliteProduct ? (sqliteProduct as unknown as JsonValue) : undefined,
          recentMessages: Array.isArray(sqliteProduct?.recentMessages)
            ? (sqliteProduct!.recentMessages as JsonValue[])
            : [],
        }
      }

      // Nothing in SQLite yet: read the legacy JSON store if present.
      return readLegacySnapshot(options.legacyMemoryPath, input)
    },

    upsertCustomer(customerId, patch) {
      const existing = this.getCustomer(customerId)
      const ts = nowIso()
      const merged: CustomerMemoryRecord = {
        customerId,
        globalSummary: patch.globalSummary ?? existing?.globalSummary ?? '',
        sessionContext: patch.sessionContext ?? existing?.sessionContext ?? {},
        bodyProfiles: patch.bodyProfiles ?? existing?.bodyProfiles ?? [],
        updatedAt: ts,
      }
      db.prepare(
        `INSERT INTO customer_memories (customer_id, global_summary, session_context_json, body_profiles_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET
           global_summary = excluded.global_summary,
           session_context_json = excluded.session_context_json,
           body_profiles_json = excluded.body_profiles_json,
           updated_at = excluded.updated_at`,
      ).run(
        customerId,
        merged.globalSummary,
        JSON.stringify(merged.sessionContext),
        JSON.stringify(merged.bodyProfiles),
        ts,
      )
    },

    upsertProduct(input, patch) {
      const existing = this.getProduct(input.customerId, input.productId, input.conversationId)
      const ts = nowIso()
      const merged: ProductMemoryRecord = {
        conversationId: input.conversationId,
        customerId: input.customerId,
        productId: input.productId,
        summary: patch.summary ?? existing?.summary ?? '',
        recentMessages: patch.recentMessages ?? existing?.recentMessages ?? [],
        conversationProfile: patch.conversationProfile ?? existing?.conversationProfile ?? {},
        reviews: patch.reviews ?? existing?.reviews ?? [],
        updatedAt: ts,
      }
      db.prepare(
        `INSERT INTO product_memories (conversation_id, customer_id, product_id, summary, recent_messages_json, conversation_profile_json, reviews_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           customer_id = excluded.customer_id,
           product_id = excluded.product_id,
           summary = excluded.summary,
           recent_messages_json = excluded.recent_messages_json,
           conversation_profile_json = excluded.conversation_profile_json,
           reviews_json = excluded.reviews_json,
           updated_at = excluded.updated_at`,
      ).run(
        input.conversationId,
        input.customerId,
        input.productId,
        merged.summary,
        JSON.stringify(merged.recentMessages),
        JSON.stringify(merged.conversationProfile),
        JSON.stringify(merged.reviews),
        ts,
      )
    },

    appendRecentMessages(input, messages, cap = 20) {
      const existing = this.getProduct(input.customerId, input.productId, input.conversationId)
      const prior = Array.isArray(existing?.recentMessages)
        ? (existing!.recentMessages as JsonValue[])
        : []
      const merged = [...prior, ...messages].slice(-cap)
      this.upsertProduct(input, { recentMessages: merged })
    },
  }
}

interface CustomerRow {
  customer_id: string
  global_summary: string
  session_context_json: string
  body_profiles_json: string
  updated_at: string
}

interface ProductRow {
  conversation_id: string
  customer_id: string
  product_id: string
  summary: string
  recent_messages_json: string
  conversation_profile_json: string
  reviews_json: string
  updated_at: string
}

function parseCustomerRow(row: CustomerRow): CustomerMemoryRecord {
  return {
    customerId: row.customer_id,
    globalSummary: row.global_summary,
    sessionContext: JSON.parse(row.session_context_json) as JsonValue,
    bodyProfiles: JSON.parse(row.body_profiles_json) as JsonValue,
    updatedAt: row.updated_at,
  }
}

function parseProductRow(row: ProductRow): ProductMemoryRecord {
  return {
    conversationId: row.conversation_id,
    customerId: row.customer_id,
    productId: row.product_id,
    summary: row.summary,
    recentMessages: JSON.parse(row.recent_messages_json) as JsonValue,
    conversationProfile: JSON.parse(row.conversation_profile_json) as JsonValue,
    reviews: JSON.parse(row.reviews_json) as JsonValue,
    updatedAt: row.updated_at,
  }
}

/**
 * Reads the legacy rag-service memory-store.json (flat map keyed by customerId,
 * with a nested productMemories map keyed by `${customerId}:${productId}`) and
 * projects it into a MemorySnapshotRecord. Read-only: the new loop never writes
 * back to this file.
 */
function readLegacySnapshot(
  legacyMemoryPath: string | undefined,
  input: SnapshotInput,
): MemorySnapshotRecord {
  const empty: MemorySnapshotRecord = {
    customerId: input.customerId,
    conversationId: input.conversationId,
    productId: input.productId,
    recentMessages: [],
  }
  if (!legacyMemoryPath || !existsSync(legacyMemoryPath)) return empty
  let store: unknown
  try {
    store = JSON.parse(readFileSync(legacyMemoryPath, 'utf8'))
  } catch {
    return empty
  }
  const map = store as Record<string, LegacyCustomerMemory> | undefined
  const legacy = map?.[input.customerId]
  if (!legacy) return empty

  const productKey = input.productId ? `${input.customerId}:${input.productId}` : undefined
  const legacyProduct = productKey ? legacy.productMemories?.[productKey] : undefined

  return {
    customerId: input.customerId,
    conversationId: input.conversationId,
    productId: input.productId,
    customerMemory: {
      globalSummary: legacy.globalSummary ?? '',
      sessionContext: legacy.sessionContext ?? {},
      bodyProfiles: legacy.bodyProfiles ?? [],
    } as JsonValue,
    productMemory: legacyProduct
      ? ({
          productId: legacyProduct.productId ?? '',
          conversationId: legacyProduct.conversationId ?? '',
          summary: legacyProduct.summary ?? '',
          recentMessages: legacyProduct.recentMessages ?? [],
          conversationProfile: legacyProduct.conversationProfile ?? {},
          reviews: legacyProduct.reviews ?? [],
        } as JsonValue)
      : undefined,
    recentMessages: Array.isArray(legacyProduct?.recentMessages)
      ? (legacyProduct!.recentMessages as JsonValue[])
      : [],
  }
}

interface LegacyCustomerMemory {
  customerId?: string
  globalSummary?: string
  sessionContext?: JsonValue
  bodyProfiles?: JsonValue
  productMemories?: Record<string, LegacyProductMemory>
}

interface LegacyProductMemory {
  productId?: string
  conversationId?: string
  summary?: string
  recentMessages?: JsonValue
  conversationProfile?: JsonValue
  reviews?: JsonValue
}
