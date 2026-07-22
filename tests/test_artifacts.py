"""ArtifactStore 行为测试（specs/artifacts.md §11 验收清单的存储层部分）。"""

from __future__ import annotations

import hashlib
import re
import sqlite3
from pathlib import Path

import pytest
from pydantic import ValidationError

from chatty.artifacts import (
    ArtifactNotFoundError,
    ArtifactStateError,
    ArtifactStore,
    DeliveryNotFoundError,
    canonical_artifact_json,
    content_review_errors,
    research_review_errors,
)
from chatty.contracts import ContentArtifact, IndustryRelation, ResearchArtifact

OWNER = "demo-customer"
REVIEWER = "demo-reviewer"
SESSION = "s1"

TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "artifacts.sqlite"


@pytest.fixture()
def store(db_path: Path):
    instance = ArtifactStore(db_path)
    yield instance
    instance.close()


def execute(db_path: Path, sql: str, params: tuple = ()) -> None:
    """绕过 store 直接改库，用于制造损坏状态（独立连接默认 foreign_keys=OFF）。"""
    connection = sqlite3.connect(db_path)
    try:
        connection.execute(sql, params)
        connection.commit()
    finally:
        connection.close()


def make_research(store: ArtifactStore, *, key="research-1", **overrides):
    kwargs = {
        "idempotency_key": key,
        "owner_id": OWNER,
        "session_id": SESSION,
        "title": "新能源产业研究",
        "summary": "摘要",
        "claims": [{"id": "c1", "text": "论断一", "source_ids": ["kb-001"]}],
        "nodes": [{"id": "n1", "label": "节点一", "kind": "company"}],
        "relations": [],
        "unknowns": [],
    }
    kwargs.update(overrides)
    return store.create_research(**kwargs)


def make_reviewed_research(store: ArtifactStore, *, key="research-1", **overrides):
    artifact = make_research(store, key=key, **overrides)
    review = store.review(artifact.id)
    assert review.passed, review.errors
    return store.get(artifact.id)


def make_content(store: ArtifactStore, parent_id: str, *, key="content-1", **overrides):
    kwargs = {
        "idempotency_key": key,
        "owner_id": OWNER,
        "session_id": SESSION,
        "research_artifact_id": parent_id,
        "title": "渠道内容",
        "channels": [
            {"channel": "xiaohongshu", "title": "标题", "body": "正文", "claim_ids": ["c1"]}
        ],
    }
    kwargs.update(overrides)
    return store.create_content(**kwargs)


def assert_state_error(excinfo: pytest.ExceptionInfo[ArtifactStateError], code: str) -> None:
    assert excinfo.value.code == code
    assert str(excinfo.value) == code


# ---- 创建与读模型 ----


def test_create_research_starts_draft(store: ArtifactStore):
    artifact = make_research(store)
    assert re.fullmatch(r"artifact_[0-9a-f]{32}", artifact.id)
    assert artifact.kind == "research"
    assert artifact.status == "draft"
    assert artifact.owner_id == OWNER
    assert artifact.session_id == SESSION
    assert TIMESTAMP_RE.fullmatch(artifact.created_at)
    assert TIMESTAMP_RE.fullmatch(artifact.updated_at)


def test_get_missing_raises_not_found(store: ArtifactStore):
    with pytest.raises(ArtifactNotFoundError) as excinfo:
        store.get("artifact_missing")
    assert str(excinfo.value) == "artifact_missing"


def test_list_orders_and_filters(store: ArtifactStore):
    a = make_research(store, key="k1")
    b = make_research(store, key="k2", session_id="s2", title="另一个")
    c = make_research(store, key="k3", title="第三个")
    assert store.list("other-owner") == []
    all_items = store.list(OWNER)
    assert {item.id for item in all_items} == {a.id, b.id, c.id}
    assert [item.id for item in all_items] == [
        item.id
        for item in sorted(all_items, key=lambda x: (x.created_at, x.id), reverse=True)
    ]
    session_items = store.list(OWNER, SESSION)
    assert {item.id for item in session_items} == {a.id, c.id}


def test_create_accepts_model_instances_and_from_alias(store: ArtifactStore):
    relation = IndustryRelation.model_validate(
        {"from": "n1", "to": "n1", "type": "supplies", "claim_id": "c1"}
    )
    a = make_research(store, key="model-in", relations=[relation])
    b = make_research(
        store,
        key="model-in",
        relations=[{"from_": "n1", "to": "n1", "type": "supplies", "claim_id": "c1"}],
    )
    assert a.id == b.id  # 两种写法序列化一致 → 幂等命中而非冲突
    assert a.relations[0].from_ == "n1"


# ---- 状态机全链路 ----


def test_full_research_lifecycle(store: ArtifactStore):
    artifact = make_research(
        store,
        nodes=[
            {"id": "n1", "label": "上游", "kind": "company"},
            {"id": "n2", "label": "下游", "kind": "company"},
        ],
        relations=[{"from": "n1", "to": "n2", "type": "supplies", "claim_id": "c1"}],
    )
    review = store.review(artifact.id)
    assert review.passed is True
    assert review.errors == []
    assert re.fullmatch(r"review_[0-9a-f]{32}", review.id)
    assert store.get(artifact.id).status == "review_pending"

    approval = store.approve(artifact.id, REVIEWER, OWNER)
    assert re.fullmatch(r"approval_[0-9a-f]{32}", approval.id)
    assert approval.decision == "approved"
    assert approval.actor_id == REVIEWER
    assert store.get(artifact.id).status == "approved"

    receipt = store.export(artifact.id, "sandbox", OWNER)
    assert re.fullmatch(r"delivery_[0-9a-f]{32}", receipt.id)
    assert receipt.target == "sandbox"
    assert re.fullmatch(r"[0-9a-f]{64}", receipt.content_hash)
    assert store.get(artifact.id).status == "exported"


def test_approve_before_review_raises(store: ArtifactStore):
    artifact = make_research(store)
    with pytest.raises(ArtifactStateError) as excinfo:
        store.approve(artifact.id, REVIEWER, OWNER)
    assert_state_error(excinfo, "artifact_not_reviewed")


def test_approve_review_failed_raises(store: ArtifactStore):
    artifact = make_research(store, claims=[])
    store.review(artifact.id)
    assert store.get(artifact.id).status == "review_failed"
    with pytest.raises(ArtifactStateError) as excinfo:
        store.approve(artifact.id, REVIEWER, OWNER)
    assert_state_error(excinfo, "artifact_not_reviewed")


def test_export_before_approve_raises(store: ArtifactStore):
    reviewed = make_reviewed_research(store)
    with pytest.raises(ArtifactStateError) as excinfo:
        store.export(reviewed.id, "sandbox", OWNER)
    assert_state_error(excinfo, "artifact_not_approved")


def test_export_unsupported_target_checked_before_db(store: ArtifactStore):
    # 未知 id 也先报 target 错误：target 检查先于任何 DB 读。
    with pytest.raises(ArtifactStateError) as excinfo:
        store.export("artifact_missing", "production", OWNER)
    assert_state_error(excinfo, "unsupported_delivery_target")


def test_owner_mismatch_hides_artifact(store: ArtifactStore):
    reviewed = make_reviewed_research(store)
    with pytest.raises(ArtifactNotFoundError) as approve_err:
        store.approve(reviewed.id, REVIEWER, "other-owner")
    assert str(approve_err.value) == reviewed.id
    store.approve(reviewed.id, REVIEWER, OWNER)
    with pytest.raises(ArtifactNotFoundError) as export_err:
        store.export(reviewed.id, "sandbox", "other-owner")
    assert str(export_err.value) == reviewed.id


def test_review_missing_artifact_raises(store: ArtifactStore):
    with pytest.raises(ArtifactNotFoundError):
        store.review("artifact_missing")


# ---- 自动 review 规则与失败字符串 ----


def test_review_failure_relation_errors_in_order(store: ArtifactStore):
    artifact = make_research(
        store,
        relations=[{"from": "n1", "to": "nX", "type": "supplies", "claim_id": "c9"}],
    )
    review = store.review(artifact.id)
    assert review.passed is False
    assert review.errors == [
        "relation_requires_nodes:n1:nX",
        "relation_requires_claim:c9",
    ]
    assert store.get(artifact.id).status == "review_failed"


def test_review_failure_empty_claims_and_order_across_rules(store: ArtifactStore):
    artifact = make_research(
        store,
        claims=[],
        relations=[{"from": "n1", "to": "n2", "type": "supplies", "claim_id": "c1"}],
    )
    review = store.review(artifact.id)
    assert review.errors == [
        "research_requires_claims",
        "relation_requires_nodes:n1:n2",
        "relation_requires_claim:c1",
    ]


def test_review_failed_is_dead_end_and_replayable(store: ArtifactStore):
    artifact = make_research(store, key="dead", claims=[])
    first = store.review(artifact.id)
    # 重复 review 返回原 review 行，状态不变。
    replay = store.review(artifact.id)
    assert replay == first
    assert store.get(artifact.id).status == "review_failed"
    # 同 key + 原 payload 重放出同一个 failed Artifact。
    again = make_research(store, key="dead", claims=[])
    assert again.id == artifact.id
    assert again.status == "review_failed"
    # 同 key + 修正后的 payload → 幂等冲突。
    with pytest.raises(ArtifactStateError) as excinfo:
        make_research(store, key="dead")
    assert_state_error(excinfo, "artifact_idempotency_conflict")


def test_defensive_review_branches():
    # claim_requires_source：契约层 source_ids min 1 下不可达，防御分支必须保留。
    errors = research_review_errors(
        {
            "claims": [{"id": "c1", "text": "t", "source_ids": []}],
            "nodes": [],
            "relations": [],
        }
    )
    assert errors == ["claim_requires_source:c1"]
    # content_requires_research：createContent 已挡住，防御分支必须保留。
    errors = content_review_errors(
        {"channels": [{"channel": "wechat", "title": "t", "body": "b", "claim_ids": ["c1"]}]},
        {"kind": "content", "claims": []},
    )
    assert errors == ["content_requires_research"]


# ---- 幂等 ----


def test_idempotent_replay_returns_current_status(store: ArtifactStore):
    artifact = make_research(store)
    store.review(artifact.id)
    replay = make_research(store)
    assert replay.id == artifact.id
    assert replay.status == "review_pending"
    store.approve(artifact.id, REVIEWER, OWNER)
    assert make_research(store).status == "approved"
    store.export(artifact.id, "sandbox", OWNER)
    assert make_research(store).status == "exported"


@pytest.mark.parametrize(
    "overrides",
    [
        {"title": "改了标题"},
        {"summary": "改了摘要"},
        {"owner_id": "other-owner"},
        {"session_id": "s2"},
        {"claims": [{"id": "c1", "text": "改了论断", "source_ids": ["kb-001"]}]},
    ],
)
def test_idempotency_conflict_on_any_difference(store: ArtifactStore, overrides):
    make_research(store, key="shared")
    with pytest.raises(ArtifactStateError) as excinfo:
        make_research(store, key="shared", **overrides)
    assert_state_error(excinfo, "artifact_idempotency_conflict")


def test_idempotency_conflict_on_kind_mismatch(store: ArtifactStore):
    make_research(store, key="shared")
    parent = make_reviewed_research(store, key="parent")
    with pytest.raises(ArtifactStateError) as excinfo:
        make_content(store, parent.id, key="shared")
    assert_state_error(excinfo, "artifact_idempotency_conflict")


# ---- content 父系（lineage） ----


def test_content_lifecycle(store: ArtifactStore):
    parent = make_reviewed_research(
        store,
        claims=[
            {"id": "c1", "text": "论断一", "source_ids": ["kb-001"]},
            {"id": "c2", "text": "论断二", "source_ids": ["kb-002"]},
        ],
    )
    content = make_content(store, parent.id)
    assert content.kind == "content"
    assert content.status == "draft"
    review = store.review(content.id)
    assert review.passed is True
    assert store.get(content.id).status == "review_pending"
    store.approve(content.id, REVIEWER, OWNER)
    receipt = store.export(content.id, "sandbox", OWNER)
    assert store.get(content.id).status == "exported"
    assert receipt.artifact_id == content.id


def test_content_review_rejects_foreign_claims_per_channel(store: ArtifactStore):
    parent = make_reviewed_research(store)
    content = make_content(
        store,
        parent.id,
        channels=[
            {"channel": "xiaohongshu", "title": "一", "body": "正文", "claim_ids": ["c1", "c2"]},
            {"channel": "douyin", "title": "二", "body": "正文", "claim_ids": ["c2"]},
        ],
    )
    review = store.review(content.id)
    assert review.passed is False
    # 同一缺失 id 出现在多个 channel 会追加多次，按 channel 顺序、claim_ids 顺序。
    assert review.errors == [
        "content_claim_not_in_research:c2",
        "content_claim_not_in_research:c2",
    ]
    assert store.get(content.id).status == "review_failed"


def test_create_content_parent_missing(store: ArtifactStore):
    with pytest.raises(ArtifactNotFoundError) as excinfo:
        make_content(store, "artifact_missing")
    assert str(excinfo.value) == "artifact_missing"


def test_create_content_parent_draft_rejected(store: ArtifactStore):
    parent = make_research(store)  # 未 review
    with pytest.raises(ArtifactStateError) as excinfo:
        make_content(store, parent.id)
    assert_state_error(excinfo, "research_artifact_not_reviewed")


def test_create_content_parent_review_failed_rejected(store: ArtifactStore):
    parent = make_research(store, claims=[])
    store.review(parent.id)
    with pytest.raises(ArtifactStateError) as excinfo:
        make_content(store, parent.id)
    assert_state_error(excinfo, "research_artifact_not_reviewed")


def test_create_content_parent_must_be_research(store: ArtifactStore):
    research = make_reviewed_research(store)
    content = make_content(store, research.id)
    store.review(content.id)  # content 落到 review_pending，但 kind 不对
    with pytest.raises(ArtifactStateError) as excinfo:
        make_content(store, content.id, key="content-2")
    assert_state_error(excinfo, "research_artifact_not_reviewed")


def test_create_content_lineage_mismatch(store: ArtifactStore):
    parent = make_reviewed_research(store)
    with pytest.raises(ArtifactStateError) as owner_err:
        make_content(store, parent.id, owner_id="other-owner")
    assert_state_error(owner_err, "artifact_lineage_mismatch")
    with pytest.raises(ArtifactStateError) as session_err:
        make_content(store, parent.id, session_id="s2")
    assert_state_error(session_err, "artifact_lineage_mismatch")


def test_content_replay_survives_parent_progress(store: ArtifactStore):
    parent = make_reviewed_research(store)
    content = make_content(store, parent.id)
    store.approve(parent.id, REVIEWER, OWNER)
    replay = make_content(store, parent.id)
    assert replay.id == content.id
    store.export(parent.id, "sandbox", OWNER)
    assert make_content(store, parent.id).id == content.id


def test_review_content_parent_deleted_raises_not_found(store: ArtifactStore, db_path: Path):
    parent = make_reviewed_research(store)
    content = make_content(store, parent.id)
    execute(db_path, "DELETE FROM artifact_reviews WHERE artifact_id = ?", (parent.id,))
    execute(db_path, "DELETE FROM artifacts WHERE id = ?", (parent.id,))
    with pytest.raises(ArtifactNotFoundError) as excinfo:
        store.review(content.id)
    assert str(excinfo.value) == parent.id


# ---- review/approve/export 重放与状态一致性 ----


def test_review_replay_never_downgrades(store: ArtifactStore):
    artifact = make_research(store)
    first = store.review(artifact.id)
    store.approve(artifact.id, REVIEWER, OWNER)
    assert store.review(artifact.id) == first
    assert store.get(artifact.id).status == "approved"
    store.export(artifact.id, "sandbox", OWNER)
    assert store.review(artifact.id) == first
    assert store.get(artifact.id).status == "exported"


def test_approve_replay_returns_same_receipt(store: ArtifactStore):
    reviewed = make_reviewed_research(store)
    first = store.approve(reviewed.id, REVIEWER, OWNER)
    assert store.approve(reviewed.id, REVIEWER, OWNER) == first
    store.export(reviewed.id, "sandbox", OWNER)
    assert store.approve(reviewed.id, REVIEWER, OWNER) == first


def test_review_state_corrupt_when_status_contradicts_review(store: ArtifactStore, db_path: Path):
    artifact = make_research(store)
    store.review(artifact.id)
    execute(db_path, "UPDATE artifacts SET status = 'draft' WHERE id = ?", (artifact.id,))
    with pytest.raises(ArtifactStateError) as excinfo:
        store.review(artifact.id)
    assert_state_error(excinfo, "artifact_state_corrupt")


def test_review_state_corrupt_when_failed_review_but_pending(
    store: ArtifactStore, db_path: Path
):
    artifact = make_research(store, claims=[])
    store.review(artifact.id)
    execute(
        db_path, "UPDATE artifacts SET status = 'review_pending' WHERE id = ?", (artifact.id,)
    )
    with pytest.raises(ArtifactStateError) as excinfo:
        store.review(artifact.id)
    assert_state_error(excinfo, "artifact_state_corrupt")


def test_review_state_corrupt_when_no_review_and_not_draft(
    store: ArtifactStore, db_path: Path
):
    artifact = make_research(store)
    execute(
        db_path, "UPDATE artifacts SET status = 'review_pending' WHERE id = ?", (artifact.id,)
    )
    with pytest.raises(ArtifactStateError) as excinfo:
        store.review(artifact.id)
    assert_state_error(excinfo, "artifact_state_corrupt")


def test_approve_state_corrupt_when_approval_exists_but_status_reverted(
    store: ArtifactStore, db_path: Path
):
    reviewed = make_reviewed_research(store)
    store.approve(reviewed.id, REVIEWER, OWNER)
    execute(
        db_path, "UPDATE artifacts SET status = 'review_pending' WHERE id = ?", (reviewed.id,)
    )
    with pytest.raises(ArtifactStateError) as excinfo:
        store.approve(reviewed.id, REVIEWER, OWNER)
    assert_state_error(excinfo, "artifact_state_corrupt")


def test_export_state_corrupt_when_delivery_exists_but_status_reverted(
    store: ArtifactStore, db_path: Path
):
    reviewed = make_reviewed_research(store)
    store.approve(reviewed.id, REVIEWER, OWNER)
    store.export(reviewed.id, "sandbox", OWNER)
    execute(db_path, "UPDATE artifacts SET status = 'approved' WHERE id = ?", (reviewed.id,))
    with pytest.raises(ArtifactStateError) as excinfo:
        store.export(reviewed.id, "sandbox", OWNER)
    assert_state_error(excinfo, "artifact_state_corrupt")


# ---- 损坏行读取 ----


def test_get_unknown_kind_raises_state_corrupt(store: ArtifactStore, db_path: Path):
    artifact = make_research(store)
    execute(db_path, "UPDATE artifacts SET kind = 'bogus' WHERE id = ?", (artifact.id,))
    with pytest.raises(ArtifactStateError) as excinfo:
        store.get(artifact.id)
    assert_state_error(excinfo, "artifact_state_corrupt")


@pytest.mark.parametrize("payload_json", ['{"summary":"x"}', "[]"])
def test_get_corrupt_payload_raises_validation_error(
    store: ArtifactStore, db_path: Path, payload_json: str
):
    artifact = make_research(store)
    execute(
        db_path,
        "UPDATE artifacts SET payload_json = ? WHERE id = ?",
        (payload_json, artifact.id),
    )
    with pytest.raises(ValidationError):
        store.get(artifact.id)


# ---- export 哈希与 delivery 回执 ----


def test_export_hash_is_stable_and_covers_approved_snapshot(store: ArtifactStore):
    reviewed = make_reviewed_research(store)
    store.approve(reviewed.id, REVIEWER, OWNER)
    approved = store.get(reviewed.id)
    expected = hashlib.sha256(canonical_artifact_json(approved).encode("utf-8")).hexdigest()
    receipt = store.export(reviewed.id, "sandbox", OWNER)
    assert receipt.content_hash == expected
    # 幂等重导出：同一回执、同一哈希。
    replay = store.export(reviewed.id, "sandbox", OWNER)
    assert replay == receipt
    # 哈希是导出前一刻 approved 快照，不等于 exported 状态重算值。
    exported_now = store.get(reviewed.id)
    recomputed = hashlib.sha256(
        canonical_artifact_json(exported_now).encode("utf-8")
    ).hexdigest()
    assert recomputed != receipt.content_hash


def test_get_delivery_roundtrip_and_owner_filter(store: ArtifactStore):
    reviewed = make_reviewed_research(store)
    store.approve(reviewed.id, REVIEWER, OWNER)
    receipt = store.export(reviewed.id, "sandbox", OWNER)
    assert store.get_delivery(receipt.id, OWNER) == receipt
    with pytest.raises(DeliveryNotFoundError) as owner_err:
        store.get_delivery(receipt.id, "other-owner")
    assert str(owner_err.value) == receipt.id
    with pytest.raises(DeliveryNotFoundError) as missing_err:
        store.get_delivery("delivery_missing", OWNER)
    assert str(missing_err.value) == "delivery_missing"


def test_get_delivery_state_corrupt(store: ArtifactStore, db_path: Path):
    reviewed = make_reviewed_research(store)
    store.approve(reviewed.id, REVIEWER, OWNER)
    receipt = store.export(reviewed.id, "sandbox", OWNER)
    execute(db_path, "UPDATE artifacts SET status = 'approved' WHERE id = ?", (reviewed.id,))
    with pytest.raises(ArtifactStateError) as excinfo:
        store.get_delivery(receipt.id, OWNER)
    assert_state_error(excinfo, "artifact_state_corrupt")


# ---- 规范序列化 ----


def test_canonical_json_research_exact_shape():
    artifact = ResearchArtifact.model_validate(
        {
            "id": "artifact_x",
            "owner_id": "demo-customer",
            "session_id": "s1",
            "title": "新能源产业研究",
            "status": "approved",
            "created_at": "2026-07-21T09:15:30.123Z",
            "updated_at": "2026-07-21T09:20:01.456Z",
            "kind": "research",
            "summary": "摘要",
            "claims": [{"id": "c1", "text": "论断", "source_ids": ["kb-001"]}],
            "nodes": [{"id": "n1", "label": "节点", "kind": "company"}],
            "relations": [{"from": "n1", "to": "n1", "type": "supplies", "claim_id": "c1"}],
            "unknowns": ["未知项"],
        }
    )
    assert canonical_artifact_json(artifact) == (
        '{"id":"artifact_x","owner_id":"demo-customer","session_id":"s1",'
        '"title":"新能源产业研究","status":"approved",'
        '"created_at":"2026-07-21T09:15:30.123Z","updated_at":"2026-07-21T09:20:01.456Z",'
        '"kind":"research","summary":"摘要",'
        '"claims":[{"id":"c1","text":"论断","source_ids":["kb-001"]}],'
        '"nodes":[{"id":"n1","label":"节点","kind":"company"}],'
        '"relations":[{"from":"n1","to":"n1","type":"supplies","claim_id":"c1"}],'
        '"unknowns":["未知项"]}'
    )


def test_canonical_json_content_exact_shape():
    artifact = ContentArtifact.model_validate(
        {
            "id": "artifact_y",
            "owner_id": "demo-customer",
            "session_id": "s1",
            "title": "渠道内容",
            "status": "approved",
            "created_at": "2026-07-21T09:15:30.123Z",
            "updated_at": "2026-07-21T09:20:01.456Z",
            "kind": "content",
            "research_artifact_id": "artifact_x",
            "channels": [
                {"channel": "xiaohongshu", "title": "标题", "body": "正文", "claim_ids": ["c1"]}
            ],
        }
    )
    assert canonical_artifact_json(artifact) == (
        '{"id":"artifact_y","owner_id":"demo-customer","session_id":"s1","title":"渠道内容",'
        '"status":"approved","created_at":"2026-07-21T09:15:30.123Z",'
        '"updated_at":"2026-07-21T09:20:01.456Z","kind":"content",'
        '"research_artifact_id":"artifact_x",'
        '"channels":[{"channel":"xiaohongshu","title":"标题","body":"正文",'
        '"claim_ids":["c1"]}]}'
    )


# ---- 时间戳刷新 ----


def test_status_updates_refresh_updated_at_format(store: ArtifactStore):
    artifact = make_research(store)
    store.review(artifact.id)
    reviewed = store.get(artifact.id)
    assert TIMESTAMP_RE.fullmatch(reviewed.updated_at)
    assert reviewed.updated_at >= reviewed.created_at
    assert reviewed.created_at == artifact.created_at
