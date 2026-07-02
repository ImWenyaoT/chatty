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
  getProduct(
    customerId: string,
    productId: string,
    conversationId: string,
  ): ProductMemoryRecord | undefined
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
  /**
   * 一轮对话结束后，把该轮产生的全部记忆变更在同一个 SQLite 事务里落库
   * （docs/architecture.md §5：memory repository 接管完整 profile 读写）：
   * - appendMessages 追加进 recentMessages 滑窗（沿用 appendRecentMessages 的
   *   截断语义，默认保留最近 `cap` 条，缺省 20）
   * - conversationProfile / summary 写 product_memories（按 conversation_id upsert）
   * - bodyProfiles / globalSummary 写 customer_memories（按 customer_id upsert）
   * patch 里未提供的字段保持数据库原值不动；任一步骤失败整体回滚，不留半行。
   */
  commitTurn(input: ProductMemoryInput, patch: MemoryCommitPatch, cap?: number): void
}

/**
 * commitTurn 的入参 patch：一轮对话希望持久化的记忆增量。
 * profile 一律按 JsonValue 存取——domain 类型不进 db 包，保持两者解耦。
 */
export interface MemoryCommitPatch {
  /** 本轮新增的消息（user/assistant），追加进 recentMessages 滑窗 */
  appendMessages?: JsonValue[]
  /** 会话级 slot 画像（product_memories.conversation_profile_json） */
  conversationProfile?: JsonValue
  /** 客户体型档案列表（customer_memories.body_profiles_json） */
  bodyProfiles?: JsonValue
  /** 当前会话摘要（product_memories.summary） */
  summary?: string
  /** 客户全局摘要（customer_memories.global_summary） */
  globalSummary?: string
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
  /** 会话级 slot 画像（conversation_profile_json 反序列化），未知时为 {} */
  conversationProfile: JsonValue
  /** 客户体型档案列表（body_profiles_json 反序列化），未知时为 [] */
  bodyProfiles: JsonValue
  /** 当前会话摘要，未知时为 '' */
  summary: string
  /** 客户全局摘要，未知时为 '' */
  globalSummary: string
}

/**
 * snapshot 的基础形状（不含派生的顶层完整记忆字段）。legacy JSON 回退路径仍按
 * 这个形状产出，由 hydrateSnapshotFields 统一补齐成完整 MemorySnapshotRecord。
 */
type MemorySnapshotBase = Omit<
  MemorySnapshotRecord,
  'conversationProfile' | 'bodyProfiles' | 'summary' | 'globalSummary'
>

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
          conversationProfile: sqliteProduct?.conversationProfile ?? {},
          bodyProfiles: sqliteCustomer?.bodyProfiles ?? [],
          summary: sqliteProduct?.summary ?? '',
          globalSummary: sqliteCustomer?.globalSummary ?? '',
        }
      }

      // Nothing in SQLite yet: read the legacy JSON store if present.
      return hydrateSnapshotFields(readLegacySnapshot(options.legacyMemoryPath, input))
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
      // 语义等价于只带 appendMessages 的 commitTurn（滑窗截断规则完全一致），
      // 收敛到同一条写路径，避免两处维护截断逻辑。
      this.commitTurn(input, { appendMessages: messages }, cap)
    },

    // 一次事务提交一轮的全部记忆变更；见接口注释。better-sqlite3 的 transaction
    // 包裹回调，回调内任一步抛错（含 JSON 序列化失败）都会整体 ROLLBACK。
    commitTurn(input, patch, cap = 20) {
      const runInTransaction = db.transaction(() => {
        // 客户维度：仅当 patch 涉及 customer_memories 字段时才 upsert，
        // 避免纯消息追加时无谓创建空客户行。
        if (patch.globalSummary !== undefined || patch.bodyProfiles !== undefined) {
          this.upsertCustomer(input.customerId, {
            globalSummary: patch.globalSummary,
            bodyProfiles: patch.bodyProfiles,
          })
        }

        // 会话维度：appendMessages 走滑窗合并，profile/summary 直接覆盖；
        // 未提供的字段由 upsertProduct 的合并语义保持原值。
        if (
          patch.appendMessages !== undefined ||
          patch.conversationProfile !== undefined ||
          patch.summary !== undefined
        ) {
          const existing = this.getProduct(input.customerId, input.productId, input.conversationId)
          const prior = Array.isArray(existing?.recentMessages)
            ? (existing!.recentMessages as JsonValue[])
            : []
          const recentMessages =
            patch.appendMessages !== undefined
              ? [...prior, ...patch.appendMessages].slice(-cap)
              : undefined
          this.upsertProduct(input, {
            recentMessages,
            conversationProfile: patch.conversationProfile,
            summary: patch.summary,
          })
        }
      })
      runInTransaction()
    },
  }
}

/**
 * 从基础快照（legacy JSON 回退产出）的 customerMemory / productMemory JSON 块中
 * 派生顶层完整记忆字段，使 snapshot() 无论走 SQLite 还是 legacy 回退都返回
 * 同一形状（conversationProfile / bodyProfiles / summary / globalSummary）。
 */
function hydrateSnapshotFields(base: MemorySnapshotBase): MemorySnapshotRecord {
  const customer = asJsonObject(base.customerMemory)
  const product = asJsonObject(base.productMemory)
  return {
    ...base,
    conversationProfile: product?.conversationProfile ?? {},
    bodyProfiles: customer?.bodyProfiles ?? [],
    summary: typeof product?.summary === 'string' ? product.summary : '',
    globalSummary: typeof customer?.globalSummary === 'string' ? customer.globalSummary : '',
  }
}

/**
 * 把 JsonValue 收窄成普通对象（排除数组与原始类型），便于安全取字段。
 */
function asJsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined
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
): MemorySnapshotBase {
  const empty: MemorySnapshotBase = {
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
