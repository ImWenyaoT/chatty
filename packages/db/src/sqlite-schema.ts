export const sqliteSchemaSql = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product_id TEXT,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_customer
  ON agent_sessions (customer_id, conversation_id);

CREATE TABLE IF NOT EXISTS customer_memories (
  customer_id TEXT PRIMARY KEY,
  global_summary TEXT NOT NULL DEFAULT '',
  session_context_json TEXT NOT NULL DEFAULT '{}',
  body_profiles_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_memories (
  conversation_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product_id TEXT NOT NULL DEFAULT 'general',
  summary TEXT NOT NULL DEFAULT '',
  recent_messages_json TEXT NOT NULL DEFAULT '[]',
  conversation_profile_json TEXT NOT NULL DEFAULT '{}',
  reviews_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_memories_customer
  ON product_memories (customer_id, product_id);

CREATE TABLE IF NOT EXISTS agent_traces (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  intent TEXT,
  action TEXT,
  input_json TEXT NOT NULL,
  output_json TEXT,
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  references_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_session
  ON agent_traces (session_id, created_at);
`

/**
 * Returns the MVP SQLite schema without opening a database connection.
 */
export function getSqliteSchemaSql() {
  return sqliteSchemaSql
}
