"""契约模型测试：RunResponse 交叉校验、Artifact 判别联合、extra 策略。"""

from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from chatty.contracts import (
    Artifact,
    ArtifactList,
    ContentArtifact,
    ContentChannel,
    ErrorResponse,
    IndustryRelation,
    KnowledgeRecord,
    Order,
    ResearchArtifact,
    ResearchClaim,
    RunRequest,
    RunResponse,
    TraceDashboard,
    TraceSpan,
    run_status,
)

# ---------------------------------------------------------------------------
# RunResponse 交叉校验（http-contract.md §2.6 规则 1..5）
# ---------------------------------------------------------------------------


def run_response_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "reply": "好的",
        "customer_id": "demo-customer",
        "session_id": "session_1",
        "trace_id": "trace_1",
        "request_id": "request_1",
        "status": "responded",
        "business_outcome": "not_applicable",
        "completion_evidence": None,
        "knowledge_search_results": [],
        "memory_events": [],
        "needs_human": False,
        "support_request_id": None,
    }
    payload.update(overrides)
    return payload


def test_run_status_is_the_single_derivation() -> None:
    """run 循环与 model_validator 共用这一条映射，不存在第二份表。"""
    assert run_status(business_outcome="verified", support_request_id=None) == "completed"
    assert (
        run_status(business_outcome="not_completed", support_request_id=None) == "not_completed"
    )
    assert run_status(business_outcome="not_applicable", support_request_id=None) == "responded"
    # 有 handoff 回执时 outcome 不参与判断。
    for outcome in ("verified", "not_completed", "not_applicable"):
        assert run_status(business_outcome=outcome, support_request_id="sr_1") == "needs_human"


def test_status_must_match_derivation() -> None:
    """status 与 run_status 的派生结果不一致即违约（复算断言）。"""
    with pytest.raises(ValidationError, match="completed run must include verified evidence"):
        RunResponse.model_validate(
            run_response_payload(
                status="completed",
                business_outcome="not_completed",
                completion_evidence="failed:sold_out",
            )
        )


def test_needs_human_valid_handoff() -> None:
    run = RunResponse.model_validate(
        run_response_payload(
            status="needs_human",
            needs_human=True,
            business_outcome="not_completed",
            support_request_id="sr_1",
            completion_evidence="handoff:sr_1",
        )
    )
    assert run.support_request_id == "sr_1"


@pytest.mark.parametrize(
    "overrides",
    [
        {"needs_human": False},  # needs_human 标志缺失
        {"business_outcome": "verified"},  # outcome 不是 not_completed
        {"support_request_id": None, "completion_evidence": "handoff:sr_1"},  # 无工单
        {"completion_evidence": "handoff:other"},  # 回执与工单不匹配
    ],
)
def test_needs_human_invalid_variants(overrides: dict[str, Any]) -> None:
    payload = run_response_payload(
        status="needs_human",
        needs_human=True,
        business_outcome="not_completed",
        support_request_id="sr_1",
        completion_evidence="handoff:sr_1",
    )
    payload.update(overrides)
    with pytest.raises(ValidationError, match="matching handoff receipt"):
        RunResponse.model_validate(payload)


@pytest.mark.parametrize(
    "overrides",
    [
        {"needs_human": True},
        {"support_request_id": "sr_1"},
    ],
)
def test_non_handoff_run_rejects_handoff_fields(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError, match="non-handoff run cannot include a support request"):
        RunResponse.model_validate(run_response_payload(**overrides))


def test_completed_valid() -> None:
    run = RunResponse.model_validate(
        run_response_payload(
            status="completed",
            business_outcome="verified",
            completion_evidence="order:ord_1",
        )
    )
    assert run.status == "completed"


@pytest.mark.parametrize(
    "overrides",
    [
        {"business_outcome": "not_applicable", "completion_evidence": "order:ord_1"},
        {"business_outcome": "verified", "completion_evidence": None},
    ],
)
def test_completed_invalid(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError, match="completed run must include verified evidence"):
        RunResponse.model_validate(run_response_payload(status="completed", **overrides))


def test_not_completed_valid() -> None:
    run = RunResponse.model_validate(
        run_response_payload(
            status="not_completed",
            business_outcome="not_completed",
            completion_evidence="failed:sold_out",
        )
    )
    assert run.business_outcome == "not_completed"


@pytest.mark.parametrize(
    "overrides",
    [
        {"business_outcome": "verified", "completion_evidence": "failed:sold_out"},
        {"business_outcome": "not_completed", "completion_evidence": None},
    ],
)
def test_not_completed_invalid(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError, match="not_completed run must include failure evidence"):
        RunResponse.model_validate(run_response_payload(status="not_completed", **overrides))


def test_responded_valid() -> None:
    run = RunResponse.model_validate(run_response_payload())
    assert run.status == "responded"
    # support_request_id 无值时仍要出现在 JSON 输出中（null）。
    assert "support_request_id" in run.model_dump()


@pytest.mark.parametrize(
    "overrides",
    [
        {"business_outcome": "verified", "completion_evidence": None},
        {"business_outcome": "not_applicable", "completion_evidence": "order:ord_1"},
    ],
)
def test_responded_invalid(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError, match="responded run cannot claim a business outcome"):
        RunResponse.model_validate(run_response_payload(**overrides))


def test_run_response_forbids_extra() -> None:
    with pytest.raises(ValidationError):
        RunResponse.model_validate(run_response_payload(internal_error_name="boom"))


# ---------------------------------------------------------------------------
# RunRequest（§2.1，extra="ignore"）
# ---------------------------------------------------------------------------


def test_run_request_ignores_spoofed_identity() -> None:
    request = RunRequest.model_validate(
        {"message": "你好", "customer_id": "spoofed-customer", "request_id": "spoofed"}
    )
    assert request.session_id is None
    assert not hasattr(request, "customer_id")


def test_run_request_accepts_explicit_null_session() -> None:
    request = RunRequest.model_validate({"message": "你好", "session_id": None})
    assert request.session_id is None


@pytest.mark.parametrize(
    "payload",
    [
        {"message": ""},
        {"message": "x" * 20_001},
        {"session_id": "session_1"},  # message 缺失
        {"message": "你好", "session_id": ""},
        {"message": "你好", "session_id": "s" * 201},
    ],
)
def test_run_request_invalid(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        RunRequest.model_validate(payload)


# ---------------------------------------------------------------------------
# Artifact 判别联合（§2.9）
# ---------------------------------------------------------------------------

ARTIFACT_ADAPTER: TypeAdapter[Any] = TypeAdapter(Artifact)
ARTIFACT_LIST_ADAPTER: TypeAdapter[Any] = TypeAdapter(ArtifactList)


def artifact_base_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": "artifact_1",
        "owner_id": "demo-customer",
        "session_id": "session_1",
        "title": "高精地图产业研究简报",
        "status": "review_pending",
        "created_at": "2026-07-21T00:00:00Z",
        "updated_at": "2026-07-21T00:00:00Z",
    }
    payload.update(overrides)
    return payload


def research_artifact_payload(**overrides: Any) -> dict[str, Any]:
    payload = artifact_base_payload(
        kind="research",
        summary="基于本地演示资料整理。",
        claims=[
            {
                "id": "claim-position",
                "text": "高精地图连接定位、地图更新与智能驾驶应用。",
                "source_ids": ["demo-industry-map"],
            }
        ],
        nodes=[{"id": "node-1", "label": "高精地图", "kind": "product"}],
        relations=[
            {"from": "node-1", "to": "node-2", "type": "supplies", "claim_id": "claim-position"}
        ],
        unknowns=["演示资料不包含实时市场规模"],
    )
    payload.update(overrides)
    return payload


def content_artifact_payload(**overrides: Any) -> dict[str, Any]:
    payload = artifact_base_payload(
        id="artifact_2",
        kind="content",
        research_artifact_id="artifact_1",
        channels=[
            {
                "channel": "xiaohongshu",
                "title": "高精地图如何支持智能驾驶",
                "body": "从定位与地图更新理解产业链。",
                "claim_ids": ["claim-position"],
            }
        ],
    )
    payload.update(overrides)
    return payload


def test_discriminated_union_selects_research_variant() -> None:
    artifact = ARTIFACT_ADAPTER.validate_python(research_artifact_payload())
    assert isinstance(artifact, ResearchArtifact)
    assert artifact.claims[0].source_ids == ["demo-industry-map"]


def test_discriminated_union_selects_content_variant() -> None:
    artifact = ARTIFACT_ADAPTER.validate_python(content_artifact_payload())
    assert isinstance(artifact, ContentArtifact)
    assert artifact.channels[0].channel == "xiaohongshu"


def test_discriminated_union_rejects_unknown_kind() -> None:
    with pytest.raises(ValidationError):
        ARTIFACT_ADAPTER.validate_python(artifact_base_payload(kind="poster"))


def test_discriminated_union_rejects_missing_kind() -> None:
    with pytest.raises(ValidationError):
        ARTIFACT_ADAPTER.validate_python(artifact_base_payload())


def test_discriminated_union_rejects_cross_variant_fields() -> None:
    # research 变体带 content 字段 → forbid。
    with pytest.raises(ValidationError):
        ARTIFACT_ADAPTER.validate_python(research_artifact_payload(research_artifact_id="a"))


def test_artifact_list_mixed_kinds() -> None:
    artifacts = ARTIFACT_LIST_ADAPTER.validate_python(
        [research_artifact_payload(), content_artifact_payload()]
    )
    assert [type(item) for item in artifacts] == [ResearchArtifact, ContentArtifact]


def test_artifact_status_literal_enforced() -> None:
    with pytest.raises(ValidationError):
        ARTIFACT_ADAPTER.validate_python(research_artifact_payload(status="published"))


def test_research_claim_requires_at_least_one_source() -> None:
    with pytest.raises(ValidationError):
        ResearchClaim.model_validate({"id": "c1", "text": "t", "source_ids": []})


def test_research_claim_rejects_empty_source_id() -> None:
    with pytest.raises(ValidationError):
        ResearchClaim.model_validate({"id": "c1", "text": "t", "source_ids": [""]})


def test_content_artifact_requires_at_least_one_channel() -> None:
    with pytest.raises(ValidationError):
        ARTIFACT_ADAPTER.validate_python(content_artifact_payload(channels=[]))


def test_content_channel_literal_and_claim_ids() -> None:
    with pytest.raises(ValidationError):
        ContentChannel.model_validate(
            {"channel": "weibo", "title": "t", "body": "b", "claim_ids": ["c1"]}
        )
    with pytest.raises(ValidationError):
        ContentChannel.model_validate(
            {"channel": "douyin", "title": "t", "body": "b", "claim_ids": []}
        )


# ---------------------------------------------------------------------------
# IndustryRelation 的 from 别名（§2.9）
# ---------------------------------------------------------------------------


def test_industry_relation_from_alias_roundtrip() -> None:
    relation = IndustryRelation.model_validate(
        {"from": "node-1", "to": "node-2", "type": "supplies", "claim_id": "claim-1"}
    )
    assert relation.from_ == "node-1"
    # 序列化必须输出 "from" 键，而非 "from_"。
    dumped = relation.model_dump()
    assert dumped["from"] == "node-1"
    assert "from_" not in dumped
    assert '"from":' in relation.model_dump_json()


def test_industry_relation_populate_by_name() -> None:
    relation = IndustryRelation(from_="node-1", to="node-2", type="supplies", claim_id="claim-1")
    assert relation.model_dump()["from"] == "node-1"


def test_industry_relation_rejects_empty_from() -> None:
    with pytest.raises(ValidationError):
        IndustryRelation.model_validate(
            {"from": "", "to": "node-2", "type": "supplies", "claim_id": "claim-1"}
        )


# ---------------------------------------------------------------------------
# extra 策略与数值约束抽查
# ---------------------------------------------------------------------------


def test_knowledge_record_forbids_extra() -> None:
    with pytest.raises(ValidationError):
        KnowledgeRecord.model_validate(
            {
                "id": "rec-1",
                "title": "t",
                "summary": "s",
                "body": "b",
                "source": "demo://x",
                "tags": [],
                "score": 1,
            }
        )


def test_error_response_allows_extra() -> None:
    error = ErrorResponse.model_validate({"detail": "order_not_found", "hint": "extra ok"})
    assert error.detail == "order_not_found"
    assert error.model_dump()["hint"] == "extra ok"


def test_error_response_detail_accepts_array() -> None:
    error = ErrorResponse.model_validate({"detail": [{"type": "missing", "loc": ["body"]}]})
    assert isinstance(error.detail, list)


def test_trace_dashboard_rejects_negative_count() -> None:
    with pytest.raises(ValidationError):
        TraceDashboard.model_validate({"traces": [], "order_status_counts": {"pending": -1}})


def test_trace_span_duration_non_negative() -> None:
    span = {
        "span_id": "span_1",
        "trace_id": "trace_1",
        "parent_id": None,
        "span_type": "tool",
        "status": "ok",
        "summary": "s",
        "started_at": None,
        "ended_at": None,
        "duration_ms": -1,
        "error": None,
    }
    with pytest.raises(ValidationError):
        TraceSpan.model_validate(span)
    assert TraceSpan.model_validate({**span, "duration_ms": None}).duration_ms is None


def test_order_quantity_positive() -> None:
    payload = {
        "id": "ord_1",
        "customer_id": "demo-customer",
        "session_id": "session_1",
        "product_id": "prod_1",
        "product_name": "露营帐篷",
        "size": "L",
        "fulfillment_mode": "rental",
        "quantity": 0,
        "start_date": "2026-07-21",
        "end_date": "2026-07-22",
        "amount_cents": 12_000,
        "status": "pending",
        "channel": "app",
        "address": "上海",
        "risk": "low",
        "created_at": "2026-07-21T00:00:00Z",
        "updated_at": "2026-07-21T00:00:00Z",
        "events": [],
    }
    with pytest.raises(ValidationError):
        Order.model_validate(payload)
    assert Order.model_validate({**payload, "quantity": 1}).quantity == 1
