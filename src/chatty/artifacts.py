"""Artifact 子系统存储层（对应 specs/artifacts.md）。

ArtifactStore 管理 4 张表（artifacts / artifact_reviews / artifact_approvals /
artifact_deliveries）与五状态机 draft → review_pending|review_failed → approved →
exported。写事务统一 BEGIN IMMEDIATE，同一数据库文件的写事务由进程级 RLock 串行化
（decisions §4.2）。损坏行读取时让 pydantic ValidationError 裸抛（decisions §3.2）。
"""

from __future__ import annotations

import builtins
import hashlib
import json
import sqlite3
import threading
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from chatty.contracts import (
    Artifact,
    ArtifactApproval,
    ContentArtifact,
    ResearchArtifact,
)
from chatty.sqlite import database_write_lock

_MEMORY_PATH = ":memory:"

_REVIEWED_STATUSES = ("review_pending", "approved", "exported")

# DDL 逐字来自 artifacts.md §2.1（PRAGMA 单独在每个连接上执行）。
_SCHEMA = """
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS artifacts_owner_session_created
    ON artifacts (owner_id, session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS artifact_reviews (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL UNIQUE,
    passed INTEGER NOT NULL,
    errors_json TEXT NOT NULL,
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);
CREATE TABLE IF NOT EXISTS artifact_approvals (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);
CREATE TABLE IF NOT EXISTS artifact_deliveries (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    target TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (artifact_id, target),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);
"""


class ArtifactNotFoundError(Exception):
    """Artifact 不存在，或 owner 不匹配（approve/export 用它隐藏存在性）。message = artifact id。"""


class DeliveryNotFoundError(Exception):
    """delivery 不存在或 owner 不匹配。message = delivery id。"""


class ArtifactStateError(Exception):
    """状态/前置条件违规；HTTP 层映射 409。message 同 code。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ArtifactReview(BaseModel):
    """artifacts.md §3.4：内部 + Tool 返回值，不走 HTTP。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    artifact_id: str = Field(min_length=1)
    passed: bool
    errors: list[str]
    created_at: str


class DeliveryReceipt(BaseModel):
    """artifacts.md §3.4：export Tool 返回值。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    artifact_id: str = Field(min_length=1)
    target: Literal["sandbox"]
    content_hash: str = Field(min_length=1)
    created_at: str


_ARTIFACT_ADAPTER: TypeAdapter[ResearchArtifact | ContentArtifact] = TypeAdapter(Artifact)


def canonical_artifact_json(artifact: ResearchArtifact | ContentArtifact) -> str:
    """§3.1 读模型的规范序列化：固定 key 顺序、紧凑分隔符、非 ASCII 原样输出。

    key 顺序来自契约模型的字段声明顺序（公共字段 1–8 + kind 专属字段），嵌套对象同理；
    `IndustryRelation.from_` 按别名 `from` 输出。content_hash = 该字符串 UTF-8 的 sha256。
    """
    return json.dumps(artifact.model_dump(by_alias=True), ensure_ascii=False, separators=(",", ":"))


def research_review_errors(artifact: Mapping[str, Any]) -> list[str]:
    """§6.1 research 自动 review 规则；errors 生成顺序固定，可被测试观察。"""
    errors: list[str] = []
    claims = artifact["claims"]
    if not claims:
        errors.append("research_requires_claims")
    for claim in claims:
        # 防御性分支：契约层 source_ids min 1 下通常不可达，必须保留（decisions §3.2）。
        if not claim["source_ids"]:
            errors.append(f"claim_requires_source:{claim['id']}")
    node_ids = {node["id"] for node in artifact["nodes"]}
    claim_ids = {claim["id"] for claim in claims}
    for relation in artifact["relations"]:
        from_id = relation["from"]
        to_id = relation["to"]
        if from_id not in node_ids or to_id not in node_ids:
            errors.append(f"relation_requires_nodes:{from_id}:{to_id}")
        if relation["claim_id"] not in claim_ids:
            errors.append(f"relation_requires_claim:{relation['claim_id']}")
    return errors


def content_review_errors(artifact: Mapping[str, Any], parent: Mapping[str, Any]) -> list[str]:
    """§6.2 content 自动 review 规则（parent = review 时重新读取的父 research）。"""
    if parent["kind"] != "research":
        # 防御性分支：createContent 已挡住此情况，保留（decisions §3.2）。
        return ["content_requires_research"]
    parent_claim_ids = {claim["id"] for claim in parent["claims"]}
    errors: list[str] = []
    for channel in artifact["channels"]:
        for claim_id in channel["claim_ids"]:
            if claim_id not in parent_claim_ids:
                errors.append(f"content_claim_not_in_research:{claim_id}")
    return errors


def _database_write_lock(database_path: str) -> threading.RLock:
    """写锁获取（decisions §4.2）：文件库复用 chatty.sqlite 的进程级注册表（按解析后
    路径共享一把 RLock，跨 store 串行化同文件写事务）；:memory: 库彼此独立，各自新锁。
    """
    if database_path == _MEMORY_PATH:
        return threading.RLock()
    return database_write_lock(database_path)


def _as_mapping(item: Mapping[str, Any] | BaseModel) -> Mapping[str, Any]:
    if isinstance(item, BaseModel):
        return item.model_dump(by_alias=True)
    return item


def _claim_payload(claim: Mapping[str, Any] | BaseModel) -> dict[str, Any]:
    m = _as_mapping(claim)
    return {"id": m["id"], "text": m["text"], "source_ids": list(m["source_ids"])}


def _node_payload(node: Mapping[str, Any] | BaseModel) -> dict[str, Any]:
    m = _as_mapping(node)
    return {"id": m["id"], "label": m["label"], "kind": m["kind"]}


def _relation_payload(relation: Mapping[str, Any] | BaseModel) -> dict[str, Any]:
    m = _as_mapping(relation)
    from_id = m["from"] if "from" in m else m["from_"]
    return {"from": from_id, "to": m["to"], "type": m["type"], "claim_id": m["claim_id"]}


def _channel_payload(channel: Mapping[str, Any] | BaseModel) -> dict[str, Any]:
    m = _as_mapping(channel)
    return {
        "channel": m["channel"],
        "title": m["title"],
        "body": m["body"],
        "claim_ids": list(m["claim_ids"]),
    }


def _artifact_from_row(row: sqlite3.Row) -> ResearchArtifact | ContentArtifact:
    kind = row["kind"]
    if kind not in ("research", "content"):
        raise ArtifactStateError("artifact_state_corrupt")
    payload = json.loads(row["payload_json"])
    # 非 dict payload 属损坏行：不展平，让下方严格校验以 ValidationError 裸抛（→ 500）。
    extra = payload if isinstance(payload, dict) else {}
    data = {
        "id": row["id"],
        "owner_id": row["owner_id"],
        "session_id": row["session_id"],
        "title": row["title"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "kind": kind,
        **extra,
    }
    return _ARTIFACT_ADAPTER.validate_python(data)


def _review_from_row(row: sqlite3.Row) -> ArtifactReview:
    return ArtifactReview(
        id=row["id"],
        artifact_id=row["artifact_id"],
        passed=bool(row["passed"]),
        errors=json.loads(row["errors_json"]),
        created_at=row["created_at"],
    )


def _approval_from_row(row: sqlite3.Row) -> ArtifactApproval:
    return ArtifactApproval(
        id=row["id"],
        artifact_id=row["artifact_id"],
        actor_id=row["actor_id"],
        decision=row["decision"],
        created_at=row["created_at"],
    )


def _delivery_from_row(row: sqlite3.Row) -> DeliveryReceipt:
    return DeliveryReceipt(
        id=row["id"],
        artifact_id=row["artifact_id"],
        target=row["target"],
        content_hash=row["content_hash"],
        created_at=row["created_at"],
    )


class ArtifactStore:
    """Artifact 存储：创建幂等、一次性自动 review、人工 approve、sandbox export。"""

    def __init__(self, database_path: str | Path) -> None:
        path = str(database_path)
        if path != _MEMORY_PATH:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = _database_write_lock(path)
        self._connection = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.executescript(_SCHEMA)

    def close(self) -> None:
        self._connection.close()

    # ---- 创建（§5.2–§5.4） ----

    def create_research(
        self,
        *,
        idempotency_key: str,
        owner_id: str,
        session_id: str,
        title: str,
        summary: str,
        claims: Sequence[Mapping[str, Any] | BaseModel],
        nodes: Sequence[Mapping[str, Any] | BaseModel],
        relations: Sequence[Mapping[str, Any] | BaseModel],
        unknowns: Sequence[str],
    ) -> ResearchArtifact | ContentArtifact:
        payload = {
            "summary": summary,
            "claims": [_claim_payload(claim) for claim in claims],
            "nodes": [_node_payload(node) for node in nodes],
            "relations": [_relation_payload(relation) for relation in relations],
            "unknowns": list(unknowns),
        }
        return self._create(
            idempotency_key=idempotency_key,
            kind="research",
            owner_id=owner_id,
            session_id=session_id,
            title=title,
            payload=payload,
        )

    def create_content(
        self,
        *,
        idempotency_key: str,
        owner_id: str,
        session_id: str,
        research_artifact_id: str,
        title: str,
        channels: Sequence[Mapping[str, Any] | BaseModel],
    ) -> ResearchArtifact | ContentArtifact:
        # 父系检查在幂等查找之前，重放时也每次都检查（§5.4）。
        parent = self.get(research_artifact_id)
        if parent.kind != "research" or parent.status not in _REVIEWED_STATUSES:
            raise ArtifactStateError("research_artifact_not_reviewed")
        if parent.owner_id != owner_id or parent.session_id != session_id:
            raise ArtifactStateError("artifact_lineage_mismatch")
        payload = {
            "research_artifact_id": research_artifact_id,
            "channels": [_channel_payload(channel) for channel in channels],
        }
        return self._create(
            idempotency_key=idempotency_key,
            kind="content",
            owner_id=owner_id,
            session_id=session_id,
            title=title,
            payload=payload,
        )

    def _create(
        self,
        *,
        idempotency_key: str,
        kind: str,
        owner_id: str,
        session_id: str,
        title: str,
        payload: dict[str, Any],
    ) -> ResearchArtifact | ContentArtifact:
        # 幂等比较是字符串等值比较，序列化必须确定性（紧凑、非 ASCII 原样、固定 key 顺序）。
        payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        row = self._connection.execute(
            "SELECT * FROM artifacts WHERE idempotency_key = ?", (idempotency_key,)
        ).fetchone()
        if row is not None:
            existing = self.get(row["id"])
            same = (
                row["kind"] == kind
                and row["owner_id"] == owner_id
                and row["session_id"] == session_id
                and row["title"] == title
                and row["payload_json"] == payload_json
            )
            if not same:
                raise ArtifactStateError("artifact_idempotency_conflict")
            # 重放返回当前状态（可能已是 review_pending/approved/exported）。
            return existing
        artifact_id = f"artifact_{uuid.uuid4().hex}"
        # 单条 INSERT 不包事务（自动提交），并发由 idempotency_key UNIQUE 兜底（§5.10）。
        self._connection.execute(
            "INSERT INTO artifacts"
            " (id, idempotency_key, kind, owner_id, session_id, title, payload_json, status)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')",
            (artifact_id, idempotency_key, kind, owner_id, session_id, title, payload_json),
        )
        return self.get(artifact_id)

    # ---- 读（§5.5） ----

    def get(self, artifact_id: str) -> ResearchArtifact | ContentArtifact:
        row = self._connection.execute(
            "SELECT * FROM artifacts WHERE id = ?", (artifact_id,)
        ).fetchone()
        if row is None:
            raise ArtifactNotFoundError(artifact_id)
        return _artifact_from_row(row)

    def list(
        self, owner_id: str, session_id: str | None = None
    ) -> builtins.list[ResearchArtifact | ContentArtifact]:
        # 注：类作用域内 `list` 会解析到本方法名，故显式走 builtins。
        if session_id is None:
            rows = self._connection.execute(
                "SELECT * FROM artifacts WHERE owner_id = ? ORDER BY created_at DESC, id DESC",
                (owner_id,),
            ).fetchall()
        else:
            rows = self._connection.execute(
                "SELECT * FROM artifacts WHERE owner_id = ? AND session_id = ?"
                " ORDER BY created_at DESC, id DESC",
                (owner_id, session_id),
            ).fetchall()
        return [_artifact_from_row(row) for row in rows]

    # ---- 自动 review（§5.6） ----

    def review(self, artifact_id: str) -> ArtifactReview:
        artifact = self.get(artifact_id)
        row = self._connection.execute(
            "SELECT * FROM artifact_reviews WHERE artifact_id = ?", (artifact_id,)
        ).fetchone()
        if row is not None:
            # 重放路径：状态一致性断言后返回持久化 review，永不降级已 approved/exported。
            consistent = (
                artifact.status in _REVIEWED_STATUSES
                if bool(row["passed"])
                else artifact.status == "review_failed"
            )
            if not consistent:
                raise ArtifactStateError("artifact_state_corrupt")
            return _review_from_row(row)
        if artifact.status != "draft":
            raise ArtifactStateError("artifact_state_corrupt")
        if artifact.kind == "research":
            errors = research_review_errors(artifact.model_dump(by_alias=True))
        else:
            parent = self.get(artifact.research_artifact_id)
            errors = content_review_errors(
                artifact.model_dump(by_alias=True), parent.model_dump(by_alias=True)
            )
        passed = not errors
        review_id = f"review_{uuid.uuid4().hex}"
        with self._transaction():
            self._connection.execute(
                "INSERT INTO artifact_reviews (id, artifact_id, passed, errors_json)"
                " VALUES (?, ?, ?, ?)",
                (
                    review_id,
                    artifact_id,
                    1 if passed else 0,
                    json.dumps(errors, ensure_ascii=False, separators=(",", ":")),
                ),
            )
            self._set_status(artifact_id, "review_pending" if passed else "review_failed")
        return _review_from_row(self._require_row("artifact_reviews", review_id))

    # ---- 人工批准（§5.7） ----

    def approve(self, artifact_id: str, actor_id: str, owner_id: str) -> ArtifactApproval:
        artifact = self.get(artifact_id)
        if artifact.owner_id != owner_id:
            raise ArtifactNotFoundError(artifact_id)
        row = self._connection.execute(
            "SELECT * FROM artifact_approvals WHERE artifact_id = ?", (artifact_id,)
        ).fetchone()
        if row is not None:
            if artifact.status not in ("approved", "exported"):
                raise ArtifactStateError("artifact_state_corrupt")
            return _approval_from_row(row)
        if artifact.status != "review_pending":
            raise ArtifactStateError("artifact_not_reviewed")
        approval_id = f"approval_{uuid.uuid4().hex}"
        with self._transaction():
            self._connection.execute(
                "INSERT INTO artifact_approvals (id, artifact_id, actor_id, decision)"
                " VALUES (?, ?, ?, 'approved')",
                (approval_id, artifact_id, actor_id),
            )
            self._set_status(artifact_id, "approved")
        return _approval_from_row(self._require_row("artifact_approvals", approval_id))

    # ---- 导出（§5.8） ----

    def export(self, artifact_id: str, target: str, owner_id: str) -> DeliveryReceipt:
        if target != "sandbox":
            # 最先检查，先于任何 DB 读。
            raise ArtifactStateError("unsupported_delivery_target")
        artifact = self.get(artifact_id)
        if artifact.owner_id != owner_id:
            raise ArtifactNotFoundError(artifact_id)
        row = self._connection.execute(
            "SELECT * FROM artifact_deliveries WHERE artifact_id = ? AND target = ?",
            (artifact_id, target),
        ).fetchone()
        if row is not None:
            if artifact.status != "exported":
                raise ArtifactStateError("artifact_state_corrupt")
            return _delivery_from_row(row)
        if artifact.status != "approved":
            raise ArtifactStateError("artifact_not_approved")
        # 哈希覆盖导出前一刻 approved 状态的整个 Artifact（含 id、时间戳、status）。
        content_hash = hashlib.sha256(
            canonical_artifact_json(artifact).encode("utf-8")
        ).hexdigest()
        delivery_id = f"delivery_{uuid.uuid4().hex}"
        with self._transaction():
            self._connection.execute(
                "INSERT INTO artifact_deliveries (id, artifact_id, target, content_hash)"
                " VALUES (?, ?, ?, ?)",
                (delivery_id, artifact_id, target, content_hash),
            )
            self._set_status(artifact_id, "exported")
        return _delivery_from_row(self._require_row("artifact_deliveries", delivery_id))

    def get_delivery(self, delivery_id: str, owner_id: str) -> DeliveryReceipt:
        """§5.9：Harness 事后验证用，无 HTTP 端点。"""
        row = self._connection.execute(
            "SELECT artifact_deliveries.*, artifacts.status AS artifact_status"
            " FROM artifact_deliveries"
            " JOIN artifacts ON artifacts.id = artifact_deliveries.artifact_id"
            " WHERE artifact_deliveries.id = ? AND artifacts.owner_id = ?",
            (delivery_id, owner_id),
        ).fetchone()
        if row is None:
            raise DeliveryNotFoundError(delivery_id)
        if row["artifact_status"] != "exported":
            raise ArtifactStateError("artifact_state_corrupt")
        return _delivery_from_row(row)

    # ---- 内部 ----

    def _set_status(self, artifact_id: str, status: str) -> None:
        self._connection.execute(
            "UPDATE artifacts"
            " SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
            " WHERE id = ?",
            (status, artifact_id),
        )

    def _require_row(self, table: str, row_id: str) -> sqlite3.Row:
        # table 只来自内部字面量，无注入面。
        row = self._connection.execute(
            f"SELECT * FROM {table} WHERE id = ?", (row_id,)
        ).fetchone()
        if row is None:  # pragma: no cover - 刚插入的行必然存在
            raise RuntimeError(f"row vanished: {table}/{row_id}")
        return row

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        """BEGIN IMMEDIATE → 写语句 → COMMIT；异常时 ROLLBACK 并重抛（§5.10）。"""
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise
            self._connection.execute("COMMIT")
