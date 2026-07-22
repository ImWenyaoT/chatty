"""人工接管请求存储：SupportRequestStore（specs/stores.md §3）。"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from chatty.sqlite import Database, string_array, text


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


class SupportRequestIdempotencyConflictError(RuntimeError):
    pass


class SupportRequestStore:
    """人工接管请求（support_requests）：幂等创建 + 同 key 异证据冲突。"""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database = Database(self.database_path)
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
