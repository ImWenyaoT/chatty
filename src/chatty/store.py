"""Chatty SQLite 存储层：MemoryStore / SupportRequestStore / TraceStore 及共享连接设施。

规格：specs/stores.md §0、§2–§4。连接模型按 decisions.md §4.2：
每 store 一条长连接（check_same_thread=False、isolation_level=None 自管事务）、
显式 BEGIN IMMEDIATE 写事务、每个数据库文件一把进程级 threading.RLock 串行化写事务。
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


@dataclass(frozen=True)
class CustomerMemory:
    memory_id: str
    customer_id: str
    fact: str
    source_id: str
    created_at: str


@dataclass(frozen=True)
class SupportRequest:
    id: str
    customer_id: str
    session_id: str
    reason: str
    context: str
    model_context: str
    prior_actions: list[str]
    status: str
    created_at: str
    updated_at: str


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


class SessionCustomerMismatchError(RuntimeError):
    pass


class SessionNotFoundError(RuntimeError):
    pass


class SupportRequestIdempotencyConflictError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# 共享连接设施（commerce/knowledge/artifacts 复用；decisions.md §4.2）
# ---------------------------------------------------------------------------

_DATABASE_LOCKS: dict[str, threading.RLock] = {}
_DATABASE_LOCKS_GUARD = threading.Lock()


def database_write_lock(database_path: str | Path) -> threading.RLock:
    """按数据库文件返回进程级写事务锁（同一文件全进程共享一把 RLock）。"""
    key = str(Path(database_path).resolve())
    with _DATABASE_LOCKS_GUARD:
        lock = _DATABASE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _DATABASE_LOCKS[key] = lock
        return lock


def open_connection(database_path: str | Path) -> sqlite3.Connection:
    """打开 store 长连接：mkdir 父目录 + Row 工厂 + 每连接开启外键 + 自管事务。"""
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def write_transaction(
    connection: sqlite3.Connection, lock: threading.RLock
) -> Iterator[sqlite3.Connection]:
    """BEGIN IMMEDIATE → 操作 → COMMIT；异常 ROLLBACK 并重抛。锁串行化同文件写事务。"""
    with lock:
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise


# ---------------------------------------------------------------------------
# 行读取契约（specs/stores.md §0.2：fail-fast，不做静默转换）
# ---------------------------------------------------------------------------


def text(row: sqlite3.Row, key: str) -> str:
    value = row[key]
    if not isinstance(value, str):
        raise ValueError(f"invalid SQLite text: {key}")
    return value


def integer(row: sqlite3.Row, key: str) -> int:
    value = row[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"invalid SQLite integer: {key}")
    return value


def nullable_text(row: sqlite3.Row, key: str) -> str | None:
    value = row[key]
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"invalid SQLite text: {key}")
    return value


def string_array(row: sqlite3.Row, key: str) -> list[str]:
    parsed = json.loads(text(row, key))
    if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
        raise ValueError(f"invalid SQLite string array: {key}")
    return parsed


# ---------------------------------------------------------------------------
# MemoryStore（§2）
# ---------------------------------------------------------------------------

_MEMORY_QUERY_STOP_CHARACTERS = frozenset("的了和与是我你他她它们什么一下信息客户关于相关")


def _memory_query_characters(query: str) -> tuple[str, ...]:
    characters: list[str] = []
    for character in query.casefold():
        if not character.isalnum() or character in _MEMORY_QUERY_STOP_CHARACTERS:
            continue
        if character not in characters:
            characters.append(character)
    return tuple(characters[:32])


def _memory_relevance(fact: str, query: str, characters: tuple[str, ...]) -> int:
    normalized_fact = fact.casefold()
    terms = [term for term in re.split(r"\W+", query.casefold()) if term]
    exact_term_score = sum(len(term) * 3 for term in terms if term in normalized_fact)
    return exact_term_score + sum(character in normalized_fact for character in characters)


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class MemoryStore:
    """客户记忆 + 会话归属（customer_memories / customer_sessions）。"""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database = open_connection(self.database_path)
        self.database.execute(
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
        self.database.execute(
            """
            CREATE TABLE IF NOT EXISTS customer_sessions (
                session_id TEXT PRIMARY KEY,
                customer_id TEXT NOT NULL
            )
            """
        )
        self.database.execute(
            """
            CREATE INDEX IF NOT EXISTS customer_memories_customer_created
            ON customer_memories (customer_id, created_at DESC)
            """
        )

    def close(self) -> None:
        self.database.close()

    def bind_session(self, *, session_id: str, customer_id: str) -> None:
        """首次绑定即"发放"该会话，之后归属不可变（先 IGNORE 后回读，天然并发安全）。"""
        self.database.execute(
            "INSERT OR IGNORE INTO customer_sessions (session_id, customer_id) VALUES (?, ?)",
            (session_id, customer_id),
        )
        row = self.database.execute(
            "SELECT customer_id FROM customer_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None or row[0] != customer_id:
            raise SessionCustomerMismatchError("session belongs to another customer")

    def require_session(self, *, session_id: str, customer_id: str) -> None:
        row = self.database.execute(
            "SELECT customer_id FROM customer_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            raise SessionNotFoundError("session was not issued by this Harness")
        if row[0] != customer_id:
            raise SessionCustomerMismatchError("session belongs to another customer")

    def save(self, *, customer_id: str, fact: str, source_id: str) -> CustomerMemory:
        memory_id = f"memory_{uuid4().hex}"
        self.database.execute(
            """
            INSERT INTO customer_memories (memory_id, customer_id, fact, source_id)
            VALUES (?, ?, ?, ?)
            """,
            (memory_id, customer_id, fact, source_id),
        )
        row = self.database.execute(
            """
            SELECT memory_id, customer_id, fact, source_id, created_at
            FROM customer_memories
            WHERE memory_id = ?
            """,
            (memory_id,),
        ).fetchone()
        if row is None:  # pragma: no cover - 同连接插入后必可读
            raise RuntimeError("saved memory could not be read")
        return self._memory(row)

    def search(self, *, customer_id: str, query: str, limit: int) -> list[CustomerMemory]:
        """第一层子串 LIKE；0 行且 query 非空白时回退到中文单字候选 + 相关性打分。"""
        rows = self.database.execute(
            """
            SELECT memory_id, customer_id, fact, source_id, created_at
            FROM customer_memories
            WHERE customer_id = ? AND fact LIKE ? ESCAPE '\\'
            ORDER BY created_at DESC, memory_id DESC
            LIMIT ?
            """,
            (customer_id, f"%{_escape_like(query)}%", limit),
        ).fetchall()
        if not rows and query.strip():
            characters = _memory_query_characters(query)
            if characters:
                predicates = " OR ".join("fact LIKE ?" for _ in characters)
                rows = self.database.execute(
                    f"""
                    SELECT memory_id, customer_id, fact, source_id, created_at
                    FROM customer_memories
                    WHERE customer_id = ? AND ({predicates})
                    ORDER BY created_at DESC, memory_id DESC
                    LIMIT ?
                    """,
                    (
                        customer_id,
                        *(f"%{character}%" for character in characters),
                        min(100, max(20, limit * 10)),
                    ),
                ).fetchall()
                rows = sorted(
                    rows,
                    key=lambda row: -_memory_relevance(str(row["fact"]), query, characters),
                )[:limit]
        return [self._memory(row) for row in rows]

    @staticmethod
    def _memory(row: sqlite3.Row) -> CustomerMemory:
        return CustomerMemory(
            memory_id=text(row, "memory_id"),
            customer_id=text(row, "customer_id"),
            fact=text(row, "fact"),
            source_id=text(row, "source_id"),
            created_at=text(row, "created_at"),
        )


# ---------------------------------------------------------------------------
# SupportRequestStore（§3）
# ---------------------------------------------------------------------------


class SupportRequestStore:
    """人工接管请求（support_requests）：幂等创建 + 同 key 异证据冲突。"""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database = open_connection(self.database_path)
        self.database.execute(
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

    def close(self) -> None:
        self.database.close()

    def create(
        self,
        *,
        customer_id: str,
        session_id: str,
        reason: str,
        context: str,
        model_context: str,
        prior_actions: list[str],
        idempotency_key: str,
    ) -> SupportRequest:
        reason = reason.strip()
        context = context.strip()
        model_context = model_context.strip()
        if not reason or not context:
            raise ValueError("support reason and context are required")
        request_id = f"support_{uuid4().hex}"
        self.database.execute(
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
                model_context,
                json.dumps(prior_actions, ensure_ascii=False, separators=(",", ":")),
            ),
        )
        row = self.database.execute(
            "SELECT * FROM support_requests WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        if row is None:  # pragma: no cover - INSERT OR IGNORE 后按 key 必可读
            raise RuntimeError("support request was not persisted")
        if (
            row["customer_id"] != customer_id
            or row["session_id"] != session_id
            or row["reason"] != reason
            or row["context"] != context
            or row["model_context"] != model_context
            or list(json.loads(row["prior_actions"])) != list(prior_actions)
        ):
            raise SupportRequestIdempotencyConflictError(
                "handoff idempotency key was reused with different evidence"
            )
        return self._request(row)

    def get(self, request_id: str) -> SupportRequest | None:
        row = self.database.execute(
            "SELECT * FROM support_requests WHERE id = ?", (request_id,)
        ).fetchone()
        return self._request(row) if row else None

    def list_all(self) -> list[SupportRequest]:
        rows = self.database.execute(
            "SELECT * FROM support_requests ORDER BY created_at DESC, id DESC"
        ).fetchall()
        return [self._request(row) for row in rows]

    @staticmethod
    def _request(row: sqlite3.Row) -> SupportRequest:
        return SupportRequest(
            id=text(row, "id"),
            customer_id=text(row, "customer_id"),
            session_id=text(row, "session_id"),
            reason=text(row, "reason"),
            context=text(row, "context"),
            model_context=text(row, "model_context"),
            prior_actions=string_array(row, "prior_actions"),
            status=text(row, "status"),
            created_at=text(row, "created_at"),
            updated_at=text(row, "updated_at"),
        )


# ---------------------------------------------------------------------------
# TraceStore（§4）
# ---------------------------------------------------------------------------

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
        self.database = open_connection(self.database_path)
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
