import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  createFailureCaseRepository,
  createKnowledgeRepository,
  createMemoryRepository,
  createSessionRepository,
  createTraceRepository,
  createTraceReviewRepository,
  openDatabase,
  syncKnowledgeIndex,
  type FailureCaseRepository,
  type KnowledgeRepository,
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
  knowledge: KnowledgeRepository
}

let repos: Repos | undefined

/** Opens the process-wide SQLite connection and builds the repositories once. */
function ensureInitialized(): Repos {
  if (repos) return repos
  const dbPath = process.env.CHATTY_DB_PATH ? path.resolve(process.env.CHATTY_DB_PATH) : ':memory:'
  const db = openDatabase(dbPath)
  // 知识索引幂等同步（docs/agentic-search-design.md §2.4 I1）：启动时对比语料
  // hash，变更才整体重建。候选路径同 legacy-adapter：repo 根或 apps/web 两种 cwd。
  const knowledgeDir = [
    path.resolve(process.cwd(), 'knowledge'),
    path.resolve(process.cwd(), '../../knowledge'),
  ].find((dir) => existsSync(dir))
  if (knowledgeDir) syncKnowledgeIndex(db, knowledgeDir)
  repos = {
    sessions: createSessionRepository(db),
    traces: createTraceRepository(db),
    reviews: createTraceReviewRepository(db),
    failures: createFailureCaseRepository(db),
    memory: createMemoryRepository(db, {
      legacyMemoryPath: path.resolve('rag-service/data/memory-store.json'),
    }),
    knowledge: createKnowledgeRepository(db),
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
