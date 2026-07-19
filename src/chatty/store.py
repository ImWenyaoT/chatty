from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


@dataclass(frozen=True)
class TraceSummary:
    trace_id: str
    session_id: str
    status: str
    summary: str
    model_id: str
    created_at: str
    updated_at: str
    duration_ms: int
    business_outcome: str | None
    completion_evidence: str | None
    knowledge_sources: tuple[str, ...]
    memory_sources: tuple[str, ...]
    support_request_id: str | None


@dataclass(frozen=True)
class CustomerMemory:
    memory_id: str
    customer_id: str
    fact: str
    source_id: str
    created_at: str


@dataclass(frozen=True)
class TraceSpanSummary:
    span_id: str
    trace_id: str
    parent_id: str | None
    span_type: str
    status: str
    summary: str
    started_at: str | None
    ended_at: str | None
    duration_ms: int | None
    error: str | None


@dataclass(frozen=True)
class SupportRequest:
    id: str
    customer_id: str
    session_id: str
    reason: str
    context: str
    model_context: str
    prior_actions: tuple[str, ...]
    status: str
    created_at: str
    updated_at: str


class SessionCustomerMismatchError(RuntimeError):
    pass


class SessionNotFoundError(RuntimeError):
    pass


class SupportRequestIdempotencyConflictError(RuntimeError):
    pass


TRACE_PROJECTION = """
    trace_id, session_id, status, summary, model_id,
    created_at, updated_at,
    MAX(0, CAST((julianday(updated_at) - julianday(created_at))
        * 86400000 AS INTEGER)) AS duration_ms,
    business_outcome, completion_evidence, knowledge_sources,
    memory_sources, support_request_id
"""


@contextmanager
def sqlite_connection(database_path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


class MemoryStore:
    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS customer_memories (
                    memory_id TEXT PRIMARY KEY,
                    customer_id TEXT NOT NULL,
                    fact TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    created_at TEXT NOT NULL
                        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS customer_sessions (
                    session_id TEXT PRIMARY KEY,
                    customer_id TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS customer_memories_customer_created
                ON customer_memories (customer_id, created_at DESC)
                """
            )

    def bind_session(self, *, session_id: str, customer_id: str) -> None:
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO customer_sessions (session_id, customer_id)
                VALUES (?, ?)
                """,
                (session_id, customer_id),
            )
            row = connection.execute(
                "SELECT customer_id FROM customer_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None or row[0] != customer_id:
            raise SessionCustomerMismatchError("session belongs to another customer")

    def require_session(self, *, session_id: str, customer_id: str) -> None:
        with sqlite_connection(self.database_path) as connection:
            row = connection.execute(
                "SELECT customer_id FROM customer_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            raise SessionNotFoundError("session was not issued by this Harness")
        if row[0] != customer_id:
            raise SessionCustomerMismatchError("session belongs to another customer")

    def save(self, *, customer_id: str, fact: str, source_id: str) -> CustomerMemory:
        memory_id = f"memory_{uuid4().hex}"
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                INSERT INTO customer_memories (memory_id, customer_id, fact, source_id)
                VALUES (?, ?, ?, ?)
                """,
                (memory_id, customer_id, fact, source_id),
            )
            row = connection.execute(
                """
                SELECT memory_id, customer_id, fact, source_id, created_at
                FROM customer_memories
                WHERE memory_id = ?
                """,
                (memory_id,),
            ).fetchone()
        if row is None:  # pragma: no cover - SQLite insert/read is one transaction
            raise RuntimeError("saved memory could not be read")
        return CustomerMemory(*row)

    def search(self, *, customer_id: str, query: str, limit: int) -> list[CustomerMemory]:
        escaped_query = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        with sqlite_connection(self.database_path) as connection:
            rows = connection.execute(
                """
                SELECT memory_id, customer_id, fact, source_id, created_at
                FROM customer_memories
                WHERE customer_id = ? AND fact LIKE ? ESCAPE '\\'
                ORDER BY created_at DESC, memory_id DESC
                LIMIT ?
                """,
                (customer_id, f"%{escaped_query}%", limit),
            ).fetchall()
        return [CustomerMemory(*row) for row in rows]


class SupportRequestStore:
    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS support_requests (
                    id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    customer_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    context TEXT NOT NULL,
                    model_context TEXT NOT NULL,
                    prior_actions TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def create(
        self,
        *,
        customer_id: str,
        session_id: str,
        reason: str,
        context: str,
        model_context: str,
        prior_actions: tuple[str, ...],
        idempotency_key: str,
    ) -> SupportRequest:
        reason = reason.strip()
        context = context.strip()
        if not reason or not context:
            raise ValueError("support reason and context are required")
        with sqlite_connection(self.database_path) as connection:
            request_id = f"support_{uuid4().hex}"
            connection.execute(
                """
                INSERT OR IGNORE INTO support_requests
                    (id, idempotency_key, customer_id, session_id, reason, context,
                     model_context, prior_actions, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
                """,
                (
                    request_id,
                    idempotency_key,
                    customer_id,
                    session_id,
                    reason,
                    context,
                    model_context.strip(),
                    json.dumps(prior_actions, ensure_ascii=False),
                ),
            )
            row = connection.execute(
                "SELECT * FROM support_requests WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        if row is None:
            raise RuntimeError("support request was not persisted")
        if (
            row["customer_id"] != customer_id
            or row["session_id"] != session_id
            or row["reason"] != reason
            or row["context"] != context
            or row["model_context"] != model_context.strip()
            or tuple(json.loads(row["prior_actions"])) != prior_actions
        ):
            raise SupportRequestIdempotencyConflictError(
                "handoff idempotency key was reused with different evidence"
            )
        return self._request(row)

    def get(self, request_id: str) -> SupportRequest | None:
        with sqlite_connection(self.database_path) as connection:
            row = connection.execute(
                "SELECT * FROM support_requests WHERE id = ?", (request_id,)
            ).fetchone()
        return self._request(row) if row else None

    def list_all(self) -> list[SupportRequest]:
        with sqlite_connection(self.database_path) as connection:
            rows = connection.execute(
                "SELECT * FROM support_requests ORDER BY created_at DESC, id DESC"
            ).fetchall()
        return [self._request(row) for row in rows]

    @staticmethod
    def _request(row: sqlite3.Row) -> SupportRequest:
        return SupportRequest(
            id=row["id"],
            customer_id=row["customer_id"],
            session_id=row["session_id"],
            reason=row["reason"],
            context=row["context"],
            model_context=row["model_context"],
            prior_actions=tuple(json.loads(row["prior_actions"])),
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class TraceStore:
    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS local_traces (
                    trace_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    business_outcome TEXT,
                    completion_evidence TEXT,
                    knowledge_sources TEXT NOT NULL DEFAULT '[]',
                    memory_sources TEXT NOT NULL DEFAULT '[]',
                    support_request_id TEXT,
                    created_at TEXT NOT NULL
                        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    updated_at TEXT NOT NULL
                        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS local_spans (
                    span_id TEXT PRIMARY KEY,
                    trace_id TEXT NOT NULL,
                    parent_id TEXT,
                    span_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    started_at TEXT,
                    ended_at TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL
                        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                )
                """
            )
            self._add_missing_columns(connection)

    def start(self, trace_id: str, session_id: str, model_id: str) -> None:
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                INSERT INTO local_traces (trace_id, session_id, status, summary, model_id)
                VALUES (?, ?, 'running', 'Agent run started', ?)
                """,
                (trace_id, session_id, model_id),
            )

    def complete(self, trace_id: str) -> None:
        self._finish(trace_id, "completed", "Agent run completed")

    def fail(self, trace_id: str) -> None:
        self._finish(trace_id, "failed", "Agent run failed")

    def get(self, trace_id: str) -> TraceSummary | None:
        with sqlite_connection(self.database_path) as connection:
            row = connection.execute(
                f"""
                SELECT {TRACE_PROJECTION}
                FROM local_traces
                WHERE trace_id = ?
                """,
                (trace_id,),
            ).fetchone()
        return self._trace(row) if row else None

    def list_recent(self, *, limit: int = 50) -> list[TraceSummary]:
        with sqlite_connection(self.database_path) as connection:
            rows = connection.execute(
                f"""
                SELECT {TRACE_PROJECTION}
                FROM local_traces
                ORDER BY created_at DESC, trace_id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [self._trace(row) for row in rows]

    def record_outcome(
        self,
        trace_id: str,
        *,
        business_outcome: str,
        completion_evidence: str | None,
        knowledge_sources: list[str],
        memory_sources: list[str],
        support_request_id: str | None,
    ) -> None:
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                UPDATE local_traces
                SET business_outcome = ?, completion_evidence = ?, knowledge_sources = ?,
                    memory_sources = ?, support_request_id = ?
                WHERE trace_id = ?
                """,
                (
                    business_outcome,
                    completion_evidence,
                    json.dumps(sorted(set(knowledge_sources)), ensure_ascii=False),
                    json.dumps(sorted(set(memory_sources)), ensure_ascii=False),
                    support_request_id,
                    trace_id,
                ),
            )

    def record_span(
        self,
        *,
        span_id: str,
        trace_id: str,
        parent_id: str | None,
        span_type: str,
        failed: bool,
        name: str | None = None,
        started_at: str | None = None,
        ended_at: str | None = None,
    ) -> None:
        status = "failed" if failed else "completed"
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO local_spans
                    (span_id, trace_id, parent_id, span_type, status, summary,
                     started_at, ended_at, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    span_id,
                    trace_id,
                    parent_id,
                    span_type,
                    status,
                    f"{span_type} {name} {status}" if name else f"{span_type} span {status}",
                    started_at,
                    ended_at,
                    "sdk_span_error" if failed else None,
                ),
            )

    def record_tool_event(self, trace_id: str, *, status: str, summary: str) -> None:
        if status not in {"completed", "failed"}:
            raise ValueError("invalid tool event status")
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                INSERT INTO local_spans
                    (span_id, trace_id, parent_id, span_type, status, summary)
                VALUES (?, ?, NULL, 'tool', ?, ?)
                """,
                (f"span_{uuid4().hex}", trace_id, status, summary),
            )

    def record_error(self, trace_id: str, *, code: str) -> None:
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                INSERT INTO local_spans
                    (span_id, trace_id, parent_id, span_type, status, summary,
                     started_at, ended_at, error)
                VALUES (?, ?, NULL, 'error', 'failed', ?,
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
                """,
                (f"span_{uuid4().hex}", trace_id, code, code),
            )

    def spans(self, trace_id: str) -> list[TraceSpanSummary]:
        with sqlite_connection(self.database_path) as connection:
            rows = connection.execute(
                """
                SELECT span_id, trace_id, parent_id, span_type, status, summary,
                       started_at, ended_at,
                       CASE
                           WHEN started_at IS NULL OR ended_at IS NULL THEN NULL
                           ELSE MAX(0, CAST((julianday(ended_at) - julianday(started_at))
                               * 86400000 AS INTEGER))
                       END AS duration_ms,
                       error
                FROM local_spans
                WHERE trace_id = ?
                ORDER BY created_at, rowid
                """,
                (trace_id,),
            ).fetchall()
        return [TraceSpanSummary(*row) for row in rows]

    def span_types(self, trace_id: str) -> list[str]:
        with sqlite_connection(self.database_path) as connection:
            rows = connection.execute(
                """
                SELECT DISTINCT span_type
                FROM local_spans
                WHERE trace_id = ?
                ORDER BY span_type
                """,
                (trace_id,),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def _finish(self, trace_id: str, status: str, summary: str) -> None:
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                UPDATE local_traces
                SET status = ?, summary = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE trace_id = ?
                """,
                (status, summary, trace_id),
            )

    @staticmethod
    def _trace(row: sqlite3.Row) -> TraceSummary:
        return TraceSummary(
            trace_id=str(row["trace_id"]),
            session_id=str(row["session_id"]),
            status=str(row["status"]),
            summary=str(row["summary"]),
            model_id=str(row["model_id"]),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            duration_ms=int(row["duration_ms"]),
            business_outcome=row["business_outcome"],
            completion_evidence=row["completion_evidence"],
            knowledge_sources=tuple(json.loads(row["knowledge_sources"])),
            memory_sources=tuple(json.loads(row["memory_sources"])),
            support_request_id=row["support_request_id"],
        )

    @staticmethod
    def _add_missing_columns(connection: sqlite3.Connection) -> None:
        trace_columns = {row[1] for row in connection.execute("PRAGMA table_info(local_traces)")}
        for name, declaration in {
            "business_outcome": "TEXT",
            "completion_evidence": "TEXT",
            "knowledge_sources": "TEXT NOT NULL DEFAULT '[]'",
            "memory_sources": "TEXT NOT NULL DEFAULT '[]'",
            "support_request_id": "TEXT",
        }.items():
            if name not in trace_columns:
                connection.execute(f"ALTER TABLE local_traces ADD COLUMN {name} {declaration}")
        span_columns = {row[1] for row in connection.execute("PRAGMA table_info(local_spans)")}
        for name in ("started_at", "ended_at", "error"):
            if name not in span_columns:
                connection.execute(f"ALTER TABLE local_spans ADD COLUMN {name} TEXT")
