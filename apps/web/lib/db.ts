import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  createFailureCaseRepository,
  createMemoryRepository,
  createSessionRepository,
  createTraceRepository,
  createTraceReviewRepository,
  openDatabase,
  type FailureCaseRepository,
  type MemoryRepository,
  type SessionRepository,
  type TraceRepository,
  type TraceReviewRepository,
} from '@rental/db'

// One SQLite connection per server process. The agent loop is single-process
// in MVP (docs §5.1); a worker extraction can own its own connection later.

let sessionRepo: SessionRepository | undefined
let traceRepo: TraceRepository | undefined
let reviewRepo: TraceReviewRepository | undefined
let failureRepo: FailureCaseRepository | undefined
let memoryRepo: MemoryRepository | undefined
let sqliteEnabled = false

function sqliteOn(): boolean {
  return process.env.CHATTY_SQLITE === '1'
}

/**
 * Initialises the repositories. SQLite is opened only when CHATTY_SQLITE=1;
 * otherwise the memory repository still works in JSON-fallback read mode and
 * sessions/traces are held in memory (preserving legacy behaviour).
 */
function ensureInitialized() {
  if (sessionRepo && traceRepo && memoryRepo) return

  if (sqliteOn()) {
    const dbPath = process.env.CHATTY_DB_PATH
      ? path.resolve(process.env.CHATTY_DB_PATH)
      : ':memory:'
    const db = openDatabase(dbPath)
    sessionRepo = createSessionRepository(db)
    traceRepo = createTraceRepository(db)
    reviewRepo = createTraceReviewRepository(db)
    failureRepo = createFailureCaseRepository(db)
    memoryRepo = createMemoryRepository(db, {
      legacyMemoryPath: path.resolve('rag-service/data/memory-store.json'),
    })
    sqliteEnabled = true
    return
  }

  // JSON-only mode: no SQLite, repositories become in-memory no-ops for write,
  // memory reads from the legacy store.
  sessionRepo = createInMemorySessionRepo()
  traceRepo = createInMemoryTraceRepo()
  reviewRepo = createInMemoryTraceReviewRepo()
  failureRepo = createInMemoryFailureCaseRepo()
  memoryRepo = createMemoryRepository(openDatabase(':memory:'), {
    legacyMemoryPath: path.resolve('rag-service/data/memory-store.json'),
  })
  sqliteEnabled = false
}

export function getRepos() {
  ensureInitialized()
  return {
    sessions: sessionRepo!,
    traces: traceRepo!,
    reviews: reviewRepo!,
    failures: failureRepo!,
    memory: memoryRepo!,
    sqliteEnabled,
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

// --- in-memory fallbacks for the CHATTY_SQLITE=off path ---------------------

function createInMemorySessionRepo(): SessionRepository {
  const map = new Map<string, ReturnType<SessionRepository['get']>>()
  const base = {
    get: (id: string) => map.get(id),
    findByConversation(conversationId: string) {
      for (const s of map.values()) if (s?.conversationId === conversationId) return s
      return undefined
    },
  } as SessionRepository
  base.create = (input) => {
    const ts = new Date().toISOString()
    const session = {
      id: input.id,
      customerId: input.customerId,
      conversationId: input.conversationId,
      productId: input.productId,
      status: 'active' as const,
      currentStep: input.currentStep ?? 'init',
      createdAt: ts,
      updatedAt: ts,
    }
    map.set(input.id, session)
    return session
  }
  base.update = (id, patch) => {
    const existing = map.get(id)
    if (!existing) return undefined
    const updated = {
      ...existing,
      ...patch,
      productId: patch.productId ?? existing.productId,
      updatedAt: new Date().toISOString(),
    } as NonNullable<typeof existing>
    map.set(id, updated)
    return updated
  }
  return base
}

function createInMemoryTraceRepo(): TraceRepository {
  const map = new Map<string, import('@rental/shared').AgentTrace[]>()
  const base = {
    append(input: Parameters<TraceRepository['append']>[0]) {
      const trace = {
        id: input.id,
        sessionId: input.sessionId,
        eventType: input.eventType,
        intent: input.intent,
        action: input.action,
        input: input.input,
        output: input.output,
        toolCalls: input.toolCalls ?? [],
        references: input.references ?? [],
        createdAt: new Date().toISOString(),
      }
      const list = map.get(input.sessionId) ?? []
      list.push(trace)
      map.set(input.sessionId, list)
      return trace
    },
    queryBySession(sessionId: string) {
      return map.get(sessionId) ?? []
    },
    // In-memory mode has no review store to join against, so nothing is
    // "unevaluated"; the eval loop only runs when SQLite is enabled.
    findUnevaluated() {
      return []
    },
  } as TraceRepository
  return base
}

function createInMemoryTraceReviewRepo(): TraceReviewRepository {
  // Minimal no-op fallback for JSON-only mode; the async eval path checks
  // sqliteEnabled before writing reviews, so this is only for type alignment.
  return {
    append(input) {
      return {
        id: input.id,
        traceId: input.traceId,
        score: input.score,
        issues: input.issues ?? [],
        suggestions: input.suggestions ?? [],
        suggestedReply: input.suggestedReply,
        evaluatorModel: input.evaluatorModel,
        promptVersion: input.promptVersion,
        createdAt: new Date().toISOString(),
      }
    },
    findByTrace() {
      return []
    },
  }
}

function createInMemoryFailureCaseRepo(): FailureCaseRepository {
  return {
    create(input) {
      return {
        id: input.id,
        traceId: input.traceId,
        sessionId: input.sessionId,
        score: input.score,
        issues: input.issues ?? [],
        input: input.input,
        output: input.output,
        status: 'open',
        createdAt: new Date().toISOString(),
      }
    },
    findOpen() {
      return []
    },
    markPromoted() {
      // no-op in JSON-only mode
    },
  }
}
