"""客户记忆存储：MemoryStore + 会话归属绑定（specs/stores.md §2）。"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from chatty.sqlite import Database, text


@dataclass(frozen=True)
class CustomerMemory:
    memory_id: str
    customer_id: str
    fact: str
    source_id: str
    created_at: str


class SessionCustomerMismatchError(RuntimeError):
    pass


class SessionNotFoundError(RuntimeError):
    pass


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
        self.database = Database(self.database_path)
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
