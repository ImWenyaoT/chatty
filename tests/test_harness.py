"""Harness 状态、回执、verify_business_outcome 与 handoff 强制规则的直接测试（无 LLM）。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest
from agents.exceptions import ModelBehaviorError
from pydantic import BaseModel, ValidationError

from chatty.artifacts import ArtifactStore
from chatty.commerce import CommerceError, CommerceStore, CreateOrderInput
from chatty.contracts import CustomerMemory, KnowledgeRecord, MemoryEvent, Order
from chatty.harness import (
    MUTATION_TOOLS,
    RUN_FAILURE_HTTP_STATUS,
    AgentContext,
    AgentRunResult,
    BusinessToolReceipt,
    HandoffIdempotencyConflictError,
    HandoffPersistenceError,
    InvalidAgentOutputError,
    RunFailure,
    complete_agent_run,
    create_handoff_receipt,
    error_code,
    force_handoff,
    handoff_idempotency_key,
    persist_agent_failure,
    persist_agent_run,
    run_failure_http_status,
)
from chatty.store import MemoryStore, SupportRequestStore, TraceStore


@dataclass
class Stores:
    commerce: CommerceStore
    artifacts: ArtifactStore
    memory: MemoryStore
    support: SupportRequestStore
    traces: TraceStore


def make_stores(tmp_path: Path) -> Stores:
    return Stores(
        commerce=CommerceStore(tmp_path / "commerce.sqlite"),
        artifacts=ArtifactStore(tmp_path / "artifacts.sqlite"),
        memory=MemoryStore(tmp_path / "memory.sqlite"),
        support=SupportRequestStore(tmp_path / "support.sqlite"),
        traces=TraceStore(tmp_path / "trace.sqlite"),
    )


def make_context(
    stores: Stores,
    *,
    message: str = "你好，请帮我处理订单。",
    customer_id: str = "customer-demo",
    session_id: str = "session-1",
    request_id: str = "request-1",
) -> AgentContext:
    trace_id = f"trace_{uuid.uuid4().hex}"
    stores.traces.start(trace_id, session_id, "test-model")
    return AgentContext(
        customer_id=customer_id,
        session_id=session_id,
        commerce=stores.commerce,
        artifacts=stores.artifacts,
        message=message,
        trace_id=trace_id,
        request_id=request_id,
        memory_store=stores.memory,
        support_store=stores.support,
        trace_store=stores.traces,
    )


def create_buyout_order(context: AgentContext, key: str = "key-1") -> Order:
    return context.commerce.create_order(
        CreateOrderInput(
            idempotency_key=f"{context.session_id}:{key}",
            customer_id=context.customer_id,
            session_id=context.session_id,
            product_id="SUIT-001",
            size="M",
            fulfillment_mode="buyout",
            quantity=1,
            start_date=None,
            end_date=None,
            amount_cents=129900,
            address="上海市静安区南京西路 1 号",
            risk="低风险：老客户",
        )
    )


def create_reviewed_research(context: AgentContext, key: str = "rs-1"):
    artifact = context.artifacts.create_research(
        idempotency_key=f"{context.session_id}:{key}",
        owner_id=context.customer_id,
        session_id=context.session_id,
        title="西装租赁研究",
        summary="研究摘要",
        claims=[{"id": "c1", "text": "西装支持七天退货", "source_ids": ["kb-1"]}],
        nodes=[],
        relations=[],
        unknowns=[],
    )
    context.artifacts.review(artifact.id)
    return context.artifacts.get(artifact.id)


def kb_record(
    record_id: str = "kb-1", source: str = "https://example.com/policy"
) -> KnowledgeRecord:
    return KnowledgeRecord(
        id=record_id,
        title="退货政策",
        summary="支持七天无理由退货",
        body="所有西装支持七天无理由退货。",
        source=source,
        tags=["policy"],
    )


class _Probe(BaseModel):
    value: int


def _validation_error() -> ValidationError:
    try:
        _Probe.model_validate({"value": "not-an-int"})
    except ValidationError as error:
        return error
    raise AssertionError("expected validation error")


# ---------------------------------------------------------------- 回执与错误码


def test_record_methods_append_receipts_and_prior_actions(tmp_path):
    context = make_context(make_stores(tmp_path))
    order = create_buyout_order(context)
    context.record_read_success("view_order", f"view_order:{order.id}:pending")
    context.record_order_success("create_order", order)
    context.record_artifact_success("save_research_artifact", "artifact-1", "review_pending")
    context.record_delivery_success("export_artifact", "delivery-1", "hash-1")
    context.record_failure("confirm_order", CommerceError("insufficient_inventory"))
    assert context.prior_actions == [
        "view_order:ok",
        "create_order:ok",
        "save_research_artifact:ok",
        "export_artifact:ok",
        "confirm_order:failed",
    ]
    read, ordered, artifact, delivery, failed = context.business_receipts
    assert read == BusinessToolReceipt(
        tool_name="view_order", ok=True, evidence=f"view_order:{order.id}:pending"
    )
    assert (ordered.order_id, ordered.expected_status) == (order.id, "pending")
    assert (artifact.artifact_id, artifact.expected_artifact_status) == (
        "artifact-1",
        "review_pending",
    )
    assert (delivery.delivery_id, delivery.expected_content_hash) == ("delivery-1", "hash-1")
    assert failed.ok is False
    assert failed.error == "insufficient_inventory"


def test_error_code_maps_validation_errors_to_invalid_tool_input():
    assert error_code(_validation_error()) == "invalid_tool_input"
    # SDK 层 strict schema 校验异常统一映射（decisions §2.4）。
    assert error_code(ModelBehaviorError("Invalid JSON input for tool create_order")) == (
        "invalid_tool_input"
    )
    assert error_code(CommerceError("order_not_found")) == "order_not_found"


def test_mutation_tools_cover_orders_and_artifacts():
    expected = {
        "create_order",
        "confirm_order",
        "cancel_order",
        "save_research_artifact",
        "save_content_artifact",
        "export_artifact",
    }
    assert frozenset(expected) == MUTATION_TOOLS


# ---------------------------------------------------------------- verify_business_outcome


def test_verify_empty_receipts_is_not_applicable(tmp_path):
    context = make_context(make_stores(tmp_path))
    assert context.verify_business_outcome() == ("not_applicable", None)


def test_verify_read_receipt_short_circuits_on_evidence(tmp_path):
    context = make_context(make_stores(tmp_path))
    context.record_read_success("check_availability", "check_availability:SUIT-001:M:available=1")
    assert context.verify_business_outcome() == (
        "verified",
        "check_availability:SUIT-001:M:available=1",
    )


def test_verify_prefers_latest_mutation_over_later_read(tmp_path):
    context = make_context(make_stores(tmp_path))
    context.record_failure("create_order", CommerceError("idempotency_conflict"))
    context.record_read_success("view_order", "view_order:x:pending")
    assert context.verify_business_outcome() == (
        "not_completed",
        "create_order:idempotency_conflict",
    )


def test_verify_order_receipt_rereads_sqlite(tmp_path):
    context = make_context(make_stores(tmp_path))
    order = create_buyout_order(context)
    context.record_order_success("create_order", order)
    assert context.verify_business_outcome() == (
        "verified",
        f"create_order:{order.id}:pending",
    )


def test_verify_order_status_mismatch_raises(tmp_path):
    context = make_context(make_stores(tmp_path))
    order = create_buyout_order(context)
    context.record_order_success("create_order", order)
    context.commerce.cancel_order(order.id)  # 回执与 SQLite 现状不一致
    with pytest.raises(CommerceError, match="unverified_business_outcome"):
        context.verify_business_outcome()


def test_verify_missing_completion_evidence_raises(tmp_path):
    context = make_context(make_stores(tmp_path))
    context.business_receipts.append(BusinessToolReceipt(tool_name="create_order", ok=True))
    with pytest.raises(CommerceError, match="missing_completion_evidence"):
        context.verify_business_outcome()


def test_verify_artifact_receipt_rereads_status(tmp_path):
    context = make_context(make_stores(tmp_path))
    reviewed = create_reviewed_research(context)
    assert reviewed.status == "review_pending"
    context.record_artifact_success("save_research_artifact", reviewed.id, reviewed.status)
    assert context.verify_business_outcome() == (
        "verified",
        f"artifact:{reviewed.id}:review_pending",
    )


def test_verify_artifact_status_mismatch_raises(tmp_path):
    context = make_context(make_stores(tmp_path))
    reviewed = create_reviewed_research(context)
    context.record_artifact_success("save_research_artifact", reviewed.id, "approved")
    with pytest.raises(CommerceError, match="unverified_business_outcome"):
        context.verify_business_outcome()


def test_verify_delivery_receipt_and_hash_mismatch(tmp_path):
    context = make_context(make_stores(tmp_path))
    reviewed = create_reviewed_research(context)
    context.artifacts.approve(reviewed.id, "reviewer-1", context.customer_id)
    delivery = context.artifacts.export(reviewed.id, "sandbox", context.customer_id)
    context.record_delivery_success("export_artifact", delivery.id, delivery.content_hash)
    assert context.verify_business_outcome() == (
        "verified",
        f"delivery:{delivery.id}:{delivery.content_hash}",
    )
    context.business_receipts.clear()
    context.record_delivery_success("export_artifact", delivery.id, "forged-hash")
    with pytest.raises(CommerceError, match="unverified_business_outcome"):
        context.verify_business_outcome()


# ---------------------------------------------------------------- handoff


def test_create_handoff_receipt_persists_and_marks_context(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores, message="  请帮我转人工处理  ")
    context.prior_actions.append("view_order:failed")
    result = create_handoff_receipt(context, reason="需要人工授权", model_context="模型侧上下文")
    assert result["status"] == "open"
    assert context.support_request_id == result["support_request_id"]
    stored = stores.support.get(result["support_request_id"])
    assert stored is not None
    assert stored.reason == "需要人工授权"
    assert stored.context == "请帮我转人工处理"  # 客户消息（strip 后），非模型参数
    assert stored.model_context == "模型侧上下文"
    assert stored.prior_actions == ["view_order:failed"]
    row = stores.support.database.execute(
        "SELECT idempotency_key FROM support_requests"
    ).fetchone()
    assert row["idempotency_key"] == handoff_idempotency_key(context)
    assert row["idempotency_key"] == "customer-demo:session-1:request-1:handoff"
    spans = stores.traces.spans(context.trace_id)
    assert any(
        span.span_type == "tool"
        and span.status == "completed"
        and span.summary == "create_handoff created receipt"
        for span in spans
    )


def test_create_handoff_receipt_failure_raises_persistence_error(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    with pytest.raises(HandoffPersistenceError, match="handoff receipt could not be persisted"):
        create_handoff_receipt(context, reason="", model_context="x")
    # 干净语义（decisions §2.3）：tool 体内不追加 prior_actions，由统一入口记一次。
    assert context.prior_actions == []
    assert context.support_request_id is None
    spans = stores.traces.spans(context.trace_id)
    assert any(
        span.status == "failed" and span.summary == "create_handoff failed" for span in spans
    )


def test_force_handoff_returns_fixed_reply_and_receipt(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    knowledge = {"kb-1": kb_record()}
    result = force_handoff(
        context,
        reason="Harness 强制升级",
        details="create_handoff 调用失败或参数无效",
        knowledge_search_results=knowledge,
    )
    assert result.reply == "业务无法安全完成，已创建可追踪的人工支持请求。"
    assert result.business_outcome == "not_completed"
    assert result.support_request_id is not None
    assert result.completion_evidence == f"handoff:{result.support_request_id}"
    assert result.knowledge_search_results == [kb_record()]
    stored = stores.support.get(result.support_request_id)
    assert stored is not None
    assert stored.reason == "Harness 强制升级"
    assert stored.model_context == "create_handoff 调用失败或参数无效"
    spans = stores.traces.spans(context.trace_id)
    assert any(
        span.status == "completed"
        and span.summary == "Harness-enforced handoff receipt created"
        for span in spans
    )


def test_force_handoff_idempotency_conflict(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    force_handoff(context, reason="原因", details="证据 A", knowledge_search_results={})
    with pytest.raises(HandoffIdempotencyConflictError, match="handoff_idempotency_conflict"):
        force_handoff(context, reason="原因", details="证据 B", knowledge_search_results={})


# ---------------------------------------------------------------- complete_agent_run


def test_complete_agent_run_interrupted_forces_handoff(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    result = complete_agent_run(
        context,
        final_output="已完成",
        interrupted=True,
        attempted_tool_names=[],
        knowledge_search_results={},
    )
    assert context.prior_actions[0] == "tool_permission:approval_required"
    stored = stores.support.get(result.support_request_id)
    assert stored.reason == "Harness 需要人工权限或授权"
    assert stored.model_context == "Tool 权限边界中断了同步执行"
    assert result.reply == "业务无法安全完成，已创建可追踪的人工支持请求。"


@pytest.mark.parametrize("final_output", [None, "   ", 123])
def test_complete_agent_run_unusable_output_forces_handoff(tmp_path, final_output):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    result = complete_agent_run(
        context,
        final_output=final_output,
        interrupted=False,
        attempted_tool_names=[],
        knowledge_search_results={},
    )
    stored = stores.support.get(result.support_request_id)
    assert stored.reason == "Harness 安全恢复已耗尽"
    assert stored.model_context == "Agent 未返回可验证的客户结果"


def test_complete_agent_run_failed_create_handoff_forces_escalation(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    result = complete_agent_run(
        context,
        final_output="已为您转接人工",
        interrupted=False,
        attempted_tool_names=["create_handoff"],
        knowledge_search_results={},
    )
    stored = stores.support.get(result.support_request_id)
    assert stored.reason == "Harness 强制升级"
    assert stored.model_context == "create_handoff 调用失败或参数无效"


def test_complete_agent_run_with_receipt_keeps_model_reply(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    create_handoff_receipt(context, reason="需要授权", model_context="模型上下文")
    result = complete_agent_run(
        context,
        final_output="已为您创建人工支持请求。",
        interrupted=False,
        attempted_tool_names=["create_handoff"],
        knowledge_search_results={},
    )
    assert result.reply == "已为您创建人工支持请求。"
    assert result.support_request_id == context.support_request_id
    assert result.business_outcome == "not_completed"
    assert result.completion_evidence == f"handoff:{context.support_request_id}"


def test_complete_agent_run_knowledge_reply_must_cite_source(tmp_path):
    stores = make_stores(tmp_path)
    knowledge = {"kb-1": kb_record(source="https://example.com/policy")}
    with pytest.raises(InvalidAgentOutputError, match="Knowledge-backed reply omitted its source"):
        complete_agent_run(
            make_context(stores),
            final_output="支持七天退货。",
            interrupted=False,
            attempted_tool_names=[],
            knowledge_search_results=knowledge,
        )
    result = complete_agent_run(
        make_context(stores),
        final_output="依据 https://example.com/policy，支持七天退货。",
        interrupted=False,
        attempted_tool_names=[],
        knowledge_search_results=knowledge,
    )
    assert result.business_outcome == "not_applicable"
    assert result.completion_evidence is None
    assert result.reply == "依据 https://example.com/policy，支持七天退货。"


def test_complete_agent_run_not_completed_replaces_reply(tmp_path):
    context = make_context(make_stores(tmp_path))
    context.record_failure("create_order", CommerceError("idempotency_conflict"))
    result = complete_agent_run(
        context,
        final_output="订单已经创建好了",
        interrupted=False,
        attempted_tool_names=["create_order"],
        knowledge_search_results={},
    )
    assert result.reply == "业务操作未完成：idempotency_conflict"
    assert result.business_outcome == "not_completed"
    assert result.completion_evidence == "create_order:idempotency_conflict"
    assert result.support_request_id is None


def test_complete_agent_run_not_completed_fallback_error_code(tmp_path):
    context = make_context(make_stores(tmp_path))
    context.record_failure("create_order", RuntimeError(""))
    result = complete_agent_run(
        context,
        final_output="好了",
        interrupted=False,
        attempted_tool_names=["create_order"],
        knowledge_search_results={},
    )
    assert result.reply == "业务操作未完成：business_tool_failed"


def test_complete_agent_run_verified_order_keeps_reply(tmp_path):
    context = make_context(make_stores(tmp_path))
    order = create_buyout_order(context)
    context.record_order_success("create_order", order)
    result = complete_agent_run(
        context,
        final_output="订单已创建，状态 pending。",
        interrupted=False,
        attempted_tool_names=["create_order"],
        knowledge_search_results={},
    )
    assert result.reply == "订单已创建，状态 pending。"
    assert result.business_outcome == "verified"
    assert result.completion_evidence == f"create_order:{order.id}:pending"


# ---------------------------------------------------------------- RunFailure 与 persist


def test_run_failure_attributes_and_http_mapping():
    failure = RunFailure("llm_provider_failed", "trace-1", internal_error_name="CommerceError")
    assert str(failure) == "llm_provider_failed"
    assert failure.code == "llm_provider_failed"
    assert failure.trace_id == "trace-1"
    assert failure.internal_error_name == "CommerceError"
    assert RunFailure("llm_not_configured").trace_id is None
    assert RUN_FAILURE_HTTP_STATUS == {
        "session_not_found": 409,
        "session_customer_mismatch": 409,
        "llm_not_configured": 503,
        "handoff_idempotency_conflict": 409,
        "handoff_persistence_failed": 500,
        "llm_provider_failed": 502,
    }
    assert run_failure_http_status("handoff_idempotency_conflict") == 409
    assert run_failure_http_status("anything_unknown") == 502


def test_persist_agent_run_records_outcome_with_sorted_sources(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    memory = CustomerMemory(
        memory_id="memory-1",
        customer_id=context.customer_id,
        fact="常住上海",
        source_id="trace-earlier",
        created_at="2026-07-01T00:00:00Z",
    )
    result = AgentRunResult(
        reply="回复",
        knowledge_search_results=[
            kb_record("kb-b", source="https://example.com/b"),
            kb_record("kb-a", source="https://example.com/a"),
            kb_record("kb-a2", source="https://example.com/a"),
        ],
        memory_events=[MemoryEvent(tool="save_customer_memory", memories=[memory])],
        business_outcome="verified",
        completion_evidence="create_order:o:pending",
        support_request_id=None,
    )
    assert persist_agent_run(context, result) is result
    trace = stores.traces.get(context.trace_id)
    assert trace.business_outcome == "verified"
    assert trace.completion_evidence == "create_order:o:pending"
    assert trace.knowledge_sources == ["https://example.com/a", "https://example.com/b"]
    assert trace.memory_sources == ["trace-earlier"]


def test_persist_agent_failure_marks_trace_failed(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    persist_agent_failure(stores.traces, context.trace_id, "handoff_persistence_failed")
    trace = stores.traces.get(context.trace_id)
    assert trace.status == "failed"
    spans = stores.traces.spans(context.trace_id)
    assert any(
        span.span_type == "error"
        and span.status == "failed"
        and span.error == "handoff_persistence_failed"
        for span in spans
    )
