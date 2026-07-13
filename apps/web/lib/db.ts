import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  createKnowledgeRepository,
  createControlPlaneRepository,
  createMemoryRepository,
  createSessionRepository,
  createTraceRepository,
  createTraceReviewRepository,
  openDatabase,
  syncKnowledgeIndex,
  type KnowledgeRepository,
  type MemoryRepository,
  type SessionRepository,
  type TraceRepository,
  type TraceReviewRepository,
  type ControlPlaneRepository,
} from "@rental/db";
import { resolveChattyDatabasePath } from "./database-path.mjs";

// One SQLite connection per server process. The agent loop is single-process
// in MVP (docs §5.1); a worker extraction can own its own connection later.
// SQLite is the only persistence layer. Development defaults to data/chatty.sqlite;
// tests opt into ':memory:' explicitly and deployments can mount any file path.

interface Repos {
  sessions: SessionRepository;
  traces: TraceRepository;
  reviews: TraceReviewRepository;
  memory: MemoryRepository;
  knowledge: KnowledgeRepository;
  control: ControlPlaneRepository;
}

let repos: Repos | undefined;

/** Opens the process-wide SQLite connection and builds the repositories once. */
function ensureInitialized(): Repos {
  if (repos) return repos;
  const dbPath = resolveChattyDatabasePath(
    process.env.CHATTY_DB_PATH,
    process.cwd(),
  );
  const db = openDatabase(dbPath);
  // 知识索引幂等同步：启动时对比语料
  // hash，变更才整体重建。候选路径覆盖 repo 根或 apps/web 两种 cwd。
  const knowledgeDir = [
    path.resolve(process.cwd(), "knowledge"),
    path.resolve(process.cwd(), "../../knowledge"),
  ].find((dir) => existsSync(dir));
  if (knowledgeDir) syncKnowledgeIndex(db, knowledgeDir);
  repos = {
    sessions: createSessionRepository(db),
    traces: createTraceRepository(db),
    reviews: createTraceReviewRepository(db),
    memory: createMemoryRepository(db),
    knowledge: createKnowledgeRepository(db),
    control: createControlPlaneRepository(db),
  };
  return repos;
}

/** Returns the shared repository set backed by the single SQLite connection. */
export function getRepos(): Repos {
  return ensureInitialized();
}

/** Generates a prefixed unique id for sessions/traces. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
