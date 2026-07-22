"""本地 trace / span 存储：TraceStore（specs/stores.md §4）。"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from chatty.sqlite import Database, integer, nullable_text, string_array, text


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
    knowledge_sources: list[str]
    memory_sources: list[str]
    support_request_id: str | None


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


TRACE_PROJECTION = """
    trace_id, session_id, status, summary, model_id,
    created_at, updated_at,
    MAX(0, CAST((julianday(updated_at) - julianday(created_at))
        * 86400000 AS INTEGER)) AS duration_ms,
    business_outcome, completion_evidence, knowledge_sources,
    memory_sources, support_request_id
"""


class TraceStore:
    """本地 trace / span 存储（local_traces / local_spans），含旧库 ALTER 迁移。"""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database = Database(self.database_path)
        self.database.execute(
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
        self.database.execute(
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
        self._add_missing_columns(self.database)

    def close(self) -> None:
        self.database.close()

    def start(self, trace_id: str, session_id: str, model_id: str) -> None:
        self.database.execute(
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
        self.database.execute(
            """
            UPDATE local_traces
            SET business_outcome = ?, completion_evidence = ?, knowledge_sources = ?,
                memory_sources = ?, support_request_id = ?
            WHERE trace_id = ?
            """,
            (
                business_outcome,
                completion_evidence,
                json.dumps(
                    sorted(set(knowledge_sources)), ensure_ascii=False, separators=(",", ":")
                ),
                json.dumps(
                    sorted(set(memory_sources)), ensure_ascii=False, separators=(",", ":")
                ),
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
        self.database.execute(
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
        self.database.execute(
            """
            INSERT INTO local_spans
                (span_id, trace_id, parent_id, span_type, status, summary)
            VALUES (?, ?, NULL, 'tool', ?, ?)
            """,
            (f"span_{uuid4().hex}", trace_id, status, summary),
        )

    def record_error(self, trace_id: str, *, code: str) -> None:
        self.database.execute(
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

    def get(self, trace_id: str) -> TraceSummary | None:
        row = self.database.execute(
            f"""
            SELECT {TRACE_PROJECTION}
            FROM local_traces
            WHERE trace_id = ?
            """,
            (trace_id,),
        ).fetchone()
        return self._trace(row) if row else None

    def list_recent(self, *, limit: int = 50) -> list[TraceSummary]:
        rows = self.database.execute(
            f"""
            SELECT {TRACE_PROJECTION}
            FROM local_traces
            ORDER BY created_at DESC, trace_id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [self._trace(row) for row in rows]

    def spans(self, trace_id: str) -> list[TraceSpanSummary]:
        rows = self.database.execute(
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
        return [self._span(row) for row in rows]

    def span_types(self, trace_id: str) -> list[str]:
        rows = self.database.execute(
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
        self.database.execute(
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
            trace_id=text(row, "trace_id"),
            session_id=text(row, "session_id"),
            status=text(row, "status"),
            summary=text(row, "summary"),
            model_id=text(row, "model_id"),
            created_at=text(row, "created_at"),
            updated_at=text(row, "updated_at"),
            duration_ms=integer(row, "duration_ms"),
            business_outcome=nullable_text(row, "business_outcome"),
            completion_evidence=nullable_text(row, "completion_evidence"),
            knowledge_sources=string_array(row, "knowledge_sources"),
            memory_sources=string_array(row, "memory_sources"),
            support_request_id=nullable_text(row, "support_request_id"),
        )

    @staticmethod
    def _span(row: sqlite3.Row) -> TraceSpanSummary:
        return TraceSpanSummary(
            span_id=text(row, "span_id"),
            trace_id=text(row, "trace_id"),
            parent_id=nullable_text(row, "parent_id"),
            span_type=text(row, "span_type"),
            status=text(row, "status"),
            summary=text(row, "summary"),
            started_at=nullable_text(row, "started_at"),
            ended_at=nullable_text(row, "ended_at"),
            duration_ms=None if row["duration_ms"] is None else integer(row, "duration_ms"),
            error=nullable_text(row, "error"),
        )

    @staticmethod
    def _add_missing_columns(connection: Database) -> None:
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
