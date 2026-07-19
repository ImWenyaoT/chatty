from __future__ import annotations

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


@dataclass(frozen=True)
class CustomerMemory:
    memory_id: str
    customer_id: str
    fact: str
    source_id: str
    created_at: str


class SessionCustomerMismatchError(RuntimeError):
    pass


@contextmanager
def sqlite_connection(database_path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(database_path)
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
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

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
                """
                SELECT trace_id, session_id, status, summary, model_id
                FROM local_traces
                WHERE trace_id = ?
                """,
                (trace_id,),
            ).fetchone()
        return TraceSummary(*row) if row else None

    def record_span(
        self,
        *,
        span_id: str,
        trace_id: str,
        parent_id: str | None,
        span_type: str,
        failed: bool,
    ) -> None:
        status = "failed" if failed else "completed"
        with sqlite_connection(self.database_path) as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO local_spans
                    (span_id, trace_id, parent_id, span_type, status, summary)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    span_id,
                    trace_id,
                    parent_id,
                    span_type,
                    status,
                    f"{span_type} span {status}",
                ),
            )

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
                SET status = ?, summary = ?, updated_at = CURRENT_TIMESTAMP
                WHERE trace_id = ?
                """,
                (status, summary, trace_id),
            )
