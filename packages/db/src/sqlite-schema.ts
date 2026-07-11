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

CREATE TABLE IF NOT EXISTS agent_trace_reviews (
  trace_id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (label IN ('pass', 'fail', 'flagged')),
  reviewer TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_trace_reviews_label
  ON agent_trace_reviews (label, updated_at);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  failure_kind TEXT,
  result_json TEXT,
  cancel_requested_at TEXT,
  cancel_reason TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_active_conversation
  ON workflow_runs (conversation_id)
  WHERE status IN ('queued', 'running', 'waiting_for_approval', 'waiting_for_handoff', 'paused');

CREATE TABLE IF NOT EXISTS workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS conversation_event_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_checkpoints (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  through_trace_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  token_before INTEGER NOT NULL,
  token_after INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, version)
);

CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_trace_id TEXT NOT NULL,
  category TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_customer
  ON memory_candidates (customer_id, status, usage_count, updated_at);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  conversation_id TEXT,
  customer_id TEXT,
  payload_json TEXT NOT NULL,
  due_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_due
  ON background_jobs (status, due_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS background_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

-- 知识库全文索引（docs/archive/agentic-search-design.md §2.1）：单 FTS5 虚拟表，
-- trigram tokenizer（§2.2），元数据列 UNINDEXED，chunk_id 即 rowid。
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(
  text,
  summary,
  doc_id UNINDEXED,
  section UNINDEXED,
  source_type UNINDEXED,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS knowledge_index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_hash TEXT NOT NULL,
  built_at TEXT NOT NULL
);
`

/**
 * Returns the MVP SQLite schema without opening a database connection.
 */
export function getSqliteSchemaSql() {
  return sqliteSchemaSql
}
