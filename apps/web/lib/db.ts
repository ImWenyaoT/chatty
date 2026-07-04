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
// SQLite is the only persistence layer (docs/architecture.md §5): with
// CHATTY_DB_PATH unset it runs on ':memory:' — same code path, no durability.

interface Repos {
  sessions: SessionRepository
  traces: TraceRepository
  reviews: TraceReviewRepository
  failures: FailureCaseRepository
  memory: MemoryRepository
}

let repos: Repos | undefined

/** Opens the process-wide SQLite connection and builds the repositories once. */
function ensureInitialized(): Repos {
  if (repos) return repos
  const dbPath = process.env.CHATTY_DB_PATH ? path.resolve(process.env.CHATTY_DB_PATH) : ':memory:'
  const db = openDatabase(dbPath)
  repos = {
    sessions: createSessionRepository(db),
    traces: createTraceRepository(db),
    reviews: createTraceReviewRepository(db),
    failures: createFailureCaseRepository(db),
    memory: createMemoryRepository(db, {
      legacyMemoryPath: path.resolve('rag-service/data/memory-store.json'),
    }),
  }
  return repos
}

/** Returns the shared repository set backed by the single SQLite connection. */
export function getRepos(): Repos {
  return ensureInitialized()
}

/** Generates a prefixed unique id for sessions/traces/reviews/failure cases. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}
