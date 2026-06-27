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
  const db = new Database(path)
  // Recommended pragmas for a single-process write workload.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(getSqliteSchemaSql())
  return db
}

/**
 * Centralised timestamp helper so repositories all emit RFC-3339 in UTC.
 */
export function nowIso(): string {
  return new Date().toISOString()
}
