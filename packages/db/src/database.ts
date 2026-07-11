import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { getSqliteSchemaSql } from './sqlite-schema.js'

// better-sqlite3's default export is both the constructor and a namespace; the
// connected-instance type lives at `Database.Database`.
export type Db = Database.Database
export { Database }

/**
 * Opens (or creates) the Chatty SQLite database and ensures the MVP schema is
 * in place. Migrations are idempotent (CREATE TABLE IF NOT EXISTS).
 */
export function openDatabase(path = ':memory:'): Db {
  // Ensure the parent directory exists for file-backed databases; better-sqlite3
  // creates the file but not intermediate directories (e.g. CHATTY_DB_PATH=./data/chatty.db).
  if (path !== ':memory:' && path !== '') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new Database(path)
  // Recommended pragmas for a single-process write workload.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(getSqliteSchemaSql())
  ensureControlPlaneColumns(db)
  return db
}

/** Adds control-plane lease columns when opening a database created by an older build. */
function ensureControlPlaneColumns(db: Db): void {
  const workflowColumns = new Set(
    (db.prepare('PRAGMA table_info(workflow_runs)').all() as { name: string }[]).map(
      (column) => column.name,
    ),
  )
  for (const column of ['lease_owner', 'lease_expires_at', 'heartbeat_at', 'result_json']) {
    if (!workflowColumns.has(column)) {
      db.exec(`ALTER TABLE workflow_runs ADD COLUMN ${column} TEXT`)
    }
  }
  const queueColumns = new Set(
    (db.prepare('PRAGMA table_info(conversation_event_queue)').all() as { name: string }[]).map(
      (column) => column.name,
    ),
  )
  if (!queueColumns.has('idempotency_key')) {
    db.exec('ALTER TABLE conversation_event_queue ADD COLUMN idempotency_key TEXT')
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_event_queue_idempotency ON conversation_event_queue (idempotency_key)',
  )
}

/**
 * Centralised timestamp helper so repositories all emit RFC-3339 in UTC.
 */
export function nowIso(): string {
  return new Date().toISOString()
}
