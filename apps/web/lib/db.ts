import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  createMemoryRepository,
  createSessionRepository,
  createTraceRepository,
  openDatabase,
  type MemoryRepository,
  type SessionRepository,
  type TraceRepository,
} from '@rental/db'

// One SQLite connection per server process. The agent loop is single-process
// in MVP (docs §5.1); a worker extraction can own its own connection later.

let sessionRepo: SessionRepository | undefined
let traceRepo: TraceRepository | undefined
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
  } as TraceRepository
  return base
}
