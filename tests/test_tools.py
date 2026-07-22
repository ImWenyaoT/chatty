"""12 个 tools 的直接测试：权限边界、幂等前缀、回执、干净失败语义（无 LLM）。"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from agents.tool_context import ToolContext

from chatty.artifacts import ArtifactStore
from chatty.commerce import CommerceStore, CreateOrderInput
from chatty.contracts import KnowledgeRecord, KnowledgeSearchResult, Order
from chatty.harness import AgentContext
from chatty.knowledge import KnowledgeStore
from chatty.store import MemoryStore, SupportRequestStore, TraceStore
from chatty.tools import (
    CHATTY_TOOL_NAMES,
    TOOL_DESCRIPTIONS,
    ToolExecutionState,
    build_chatty_tools,
    execute_chatty_tool,
)

KB_RECORDS = [
    {
        "id": "kb-return-policy",
        "title": "退货政策",
        "summary": "支持七天无理由退货",
        "body": "所有西装支持七天无理由退货，需保留吊牌。",
        "source": "https://example.com/policy/return",
        "tags": ["policy"],
    },
    {
        "id": "kb-suit-care",
        "title": "西装保养指南",
        "summary": "西装需要干洗保养",
        "body": "西装需干洗，避免机洗和暴晒。",
        "source": "https://example.com/guide/care",
        "tags": [],
    },
]


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


def make_knowledge(stores: Stores, tmp_path: Path) -> KnowledgeStore:
    knowledge = KnowledgeStore(stores.commerce.database)
    source = tmp_path / "kb.jsonl"
    source.write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in KB_RECORDS),
        encoding="utf-8",
    )
    knowledge.import_jsonl(source)
    return knowledge


class _StubKnowledgeStore:
    """duck-typed 检索桩：只需要 search(query, limit=...)。"""

    def __init__(self, result: KnowledgeSearchResult) -> None:
        self._result = result

    def search(self, query: str, *, limit: int) -> KnowledgeSearchResult:
        return self._result


def run_tool(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: Any,
    tool_name: str,
    arguments: dict[str, Any] | str,
) -> dict[str, Any]:
    return json.loads(
        execute_chatty_tool(
            context=context,
            state=state,
            knowledge_store=knowledge_store,
            tool_name=tool_name,
            arguments=arguments,
        )
    )


def seed_state(state: ToolExecutionState, *record_ids: str) -> None:
    for record_id in record_ids:
        state.knowledge_search_results[record_id] = KnowledgeRecord(
            id=record_id,
            title="种子记录",
            summary="种子摘要",
            body="种子正文",
            source=f"https://example.com/{record_id}",
            tags=[],
        )


def create_buyout_order(context: AgentContext, key: str = "key-1", quantity: int = 1) -> Order:
    return context.commerce.create_order(
        CreateOrderInput(
            idempotency_key=f"{context.session_id}:{key}",
            customer_id=context.customer_id,
            session_id=context.session_id,
            product_id="SUIT-001",
            size="M",
            fulfillment_mode="buyout",
            quantity=quantity,
            start_date=None,
            end_date=None,
            amount_cents=129900,
            address="上海市静安区南京西路 1 号",
            risk="低风险：老客户",
        )
    )


ORDER_ARGS = {
    "idempotency_key": "order-key",
    "product_id": "SUIT-001",
    "size": "M",
    "fulfillment_mode": "buyout",
    "quantity": 1,
    "start_date": None,
    "end_date": None,
    "amount_cents": 129900,
    "address": "上海市静安区南京西路 1 号",
    "risk": "低风险：老客户",
}


def research_args(key: str = "rs-1", source_id: str = "kb-return-policy") -> dict[str, Any]:
    return {
        "idempotency_key": key,
        "title": "西装租赁产业研究",
        "summary": "基于本地检索的研究摘要",
        "claims": [{"id": "c1", "text": "西装支持七天退货", "source_ids": [source_id]}],
        "nodes": [{"id": "n1", "label": "西装租赁", "kind": "industry"}],
        "relations": [{"from": "n1", "to": "n1", "type": "self", "claim_id": "c1"}],
        "unknowns": ["实时价格未知"],
    }


# ---------------------------------------------------------------- 声明与 schema


def test_tool_declarations_match_spec(tmp_path):
    stores = make_stores(tmp_path)
    tools = build_chatty_tools(
        state=ToolExecutionState(), knowledge_store=make_knowledge(stores, tmp_path)
    )
    assert [tool.name for tool in tools] == list(CHATTY_TOOL_NAMES)
    assert len(tools) == 12
    by_name = {tool.name: tool for tool in tools}
    for name, description in TOOL_DESCRIPTIONS.items():
        assert by_name[name].description == description
        assert by_name[name].strict_json_schema is True
        assert by_name[name].params_json_schema.get("additionalProperties") is False
    # 服务端注入身份绝不出现在参数 schema 中（§4.3）。
    create_order_props = by_name["create_order"].params_json_schema["properties"]
    for hidden in ("customer_id", "session_id", "trace_id", "request_id"):
        assert hidden not in create_order_props
    assert set(by_name["create_handoff"].params_json_schema["properties"]) == {
        "reason",
        "context",
    }
    # relation 的 from 字段按别名进 schema。
    research_schema = json.dumps(by_name["save_research_artifact"].params_json_schema)
    assert '"from"' in research_schema


def test_execute_chatty_tool_rejects_unknown_tool(tmp_path):
    stores = make_stores(tmp_path)
    with pytest.raises(ValueError, match="unknown_tool:nope"):
        execute_chatty_tool(
            context=make_context(stores),
            state=ToolExecutionState(),
            knowledge_store=make_knowledge(stores, tmp_path),
            tool_name="nope",
            arguments={},
        )


# ---------------------------------------------------------------- search_knowledge


def test_search_knowledge_accumulates_run_state(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    payload = run_tool(context, state, knowledge, "search_knowledge", {"query": "退货政策"})
    assert "ok" not in payload  # 无 ok 包装
    assert payload["status"] == "ok"
    assert payload["query"] == "退货政策"
    assert payload["error"] is None
    assert any(record["id"] == "kb-return-policy" for record in payload["results"])
    assert "kb-return-policy" in state.knowledge_search_results
    assert context.prior_actions == ["search_knowledge:ok"]
    assert context.business_receipts == []  # 纯检索成功不产生回执（§6.3）
    run_tool(context, state, knowledge, "search_knowledge", {"query": "西装保养指南"})
    assert {"kb-return-policy", "kb-suit-care"} <= set(state.knowledge_search_results)


def test_search_knowledge_error_status_prior_action(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    stub = _StubKnowledgeStore(
        KnowledgeSearchResult(
            status="error", query="q", results=[], error="knowledge_search_unavailable"
        )
    )
    payload = run_tool(context, ToolExecutionState(), stub, "search_knowledge", {"query": "q"})
    assert payload["error"] == "knowledge_search_unavailable"
    assert context.prior_actions == ["search_knowledge:error"]
    assert context.business_receipts == []


def test_search_knowledge_invalid_params_record_invalid_tool_input(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "search_knowledge",
        {"query": ""},
    )
    assert payload["ok"] is False
    assert context.prior_actions == ["search_knowledge:failed"]
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]


# ---------------------------------------------------------------- customer memory


def test_save_customer_memory_verbatim_casefold(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores, message="请记住我的会员名是 STRASSE，谢谢")
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    raw = execute_chatty_tool(
        context=context,
        state=state,
        knowledge_store=knowledge,
        tool_name="save_customer_memory",
        arguments={"fact": " straße ", "explicitly_stated": True, "stable": True},
    )
    assert "straße" in raw  # ensure_ascii=False：原文 Unicode 不转义
    payload = json.loads(raw)
    assert payload["tool"] == "save_customer_memory"
    assert payload["memories"][0]["fact"] == "straße"  # trim 后原样保存
    assert payload["memories"][0]["source_id"] == context.trace_id
    assert payload["memories"][0]["customer_id"] == context.customer_id
    assert context.prior_actions == ["save_customer_memory:ok"]
    assert len(context.memory_events) == 1
    persisted = stores.memory.search(customer_id=context.customer_id, query="straße", limit=5)
    assert [memory.fact for memory in persisted] == ["straße"]


def test_save_customer_memory_rejects_non_verbatim_fact(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores, message="今天天气不错")
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "save_customer_memory",
        {"fact": "我喜欢蓝色西装", "explicitly_stated": True, "stable": True},
    )
    assert payload == {
        "ok": False,
        "error": "memory fact must be a verbatim part of the customer message",
    }
    # 干净语义：一次失败 = 一条 prior_action + 一条失败回执（decisions §2.3）。
    assert context.prior_actions == ["save_customer_memory:failed"]
    assert len(context.business_receipts) == 1
    assert context.business_receipts[0].error == (
        "memory fact must be a verbatim part of the customer message"
    )
    assert context.memory_events == []


def test_save_customer_memory_requires_literal_true_flags(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores, message="记住我的地址")
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "save_customer_memory",
        {"fact": "记住我的地址", "explicitly_stated": False, "stable": True},
    )
    assert payload["ok"] is False
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]


def test_search_customer_memory_returns_event(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    stores.memory.save(customer_id=context.customer_id, fact="常住上海", source_id="trace-x")
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "search_customer_memory",
        {"query": "常住上海"},
    )
    assert payload["tool"] == "search_customer_memory"
    assert [memory["fact"] for memory in payload["memories"]] == ["常住上海"]
    assert context.prior_actions == ["search_customer_memory:ok"]
    assert len(context.memory_events) == 1
    assert context.business_receipts == []


# ---------------------------------------------------------------- 订单 tools


def test_check_availability_records_read_receipt(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "check_availability",
        {
            "product_id": " suit-001 ",
            "size": "m",
            "fulfillment_mode": "buyout",
            "quantity": 1,
            "start_date": None,
            "end_date": None,
        },
    )
    assert payload["ok"] is True
    assert payload["availability"]["product_id"] == "SUIT-001"
    assert payload["availability"]["available"] is True
    receipt = context.business_receipts[-1]
    assert receipt.evidence == "check_availability:SUIT-001:M:available=1"
    # 库存不足不是错误：available=False 仍是 ok 响应（§5.4）。
    shortage = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "check_availability",
        {
            "product_id": "SUIT-001",
            "size": "M",
            "fulfillment_mode": "buyout",
            "quantity": 99,
            "start_date": None,
            "end_date": None,
        },
    )
    assert shortage["ok"] is True
    assert shortage["availability"]["available"] is False


def test_check_availability_unknown_variant(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "check_availability",
        {
            "product_id": "NOPE",
            "size": "M",
            "fulfillment_mode": "buyout",
            "quantity": 1,
            "start_date": None,
            "end_date": None,
        },
    )
    assert payload == {"ok": False, "error": "unknown_variant"}
    assert context.business_receipts[-1].error == "unknown_variant"


def test_create_order_injects_identity_and_prefixes_idempotency(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    payload = run_tool(context, state, knowledge, "create_order", ORDER_ARGS)
    assert payload["ok"] is True
    order = payload["order"]
    assert order["customer_id"] == context.customer_id
    assert order["session_id"] == context.session_id
    assert order["status"] == "pending"
    assert order["channel"] == "Chatty"  # 省略时应用默认值
    row = stores.commerce.database.execute("SELECT idempotency_key FROM orders").fetchone()
    assert row["idempotency_key"] == f"{context.session_id}:order-key"
    receipt = context.business_receipts[-1]
    assert (receipt.order_id, receipt.expected_status) == (order["id"], "pending")
    # 幂等重放返回同一订单
    replay = run_tool(context, state, knowledge, "create_order", ORDER_ARGS)
    assert replay["order"]["id"] == order["id"]
    count = stores.commerce.database.execute("SELECT COUNT(*) AS n FROM orders").fetchone()
    assert count["n"] == 1


def test_create_order_rejects_injected_identity_fields(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "create_order",
        {**ORDER_ARGS, "customer_id": "attacker"},
    )
    assert payload["ok"] is False
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]
    assert context.prior_actions == ["create_order:failed"]


def test_create_order_rental_cross_validation_in_store_layer(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "create_order",
        {**ORDER_ARGS, "fulfillment_mode": "rental"},  # rental 缺日期
    )
    assert payload["ok"] is False
    assert "invalid_rental_period" in payload["error"]
    assert context.business_receipts[-1].error == "invalid_tool_input"


def test_order_tools_hide_other_customers_orders(tmp_path):
    stores = make_stores(tmp_path)
    knowledge = make_knowledge(stores, tmp_path)
    owner = make_context(stores, customer_id="customer-a", session_id="session-a")
    order = create_buyout_order(owner)
    stranger = make_context(stores, customer_id="customer-b", session_id="session-b")
    for tool_name in ("view_order", "confirm_order", "cancel_order"):
        payload = run_tool(
            stranger, ToolExecutionState(), knowledge, tool_name, {"order_id": order.id}
        )
        assert payload == {"ok": False, "error": "order_not_found"}
    assert stranger.prior_actions == [
        "view_order:failed",
        "confirm_order:failed",
        "cancel_order:failed",
    ]
    # 归属者可读，回执带证据。
    payload = run_tool(owner, ToolExecutionState(), knowledge, "view_order", {"order_id": order.id})
    assert payload["ok"] is True
    assert owner.business_receipts[-1].evidence == f"view_order:{order.id}:pending"


def test_confirm_and_cancel_order_record_status(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    order = create_buyout_order(context)
    payload = run_tool(context, state, knowledge, "confirm_order", {"order_id": order.id})
    assert payload["order"]["status"] == "confirmed"
    assert context.business_receipts[-1].expected_status == "confirmed"
    payload = run_tool(context, state, knowledge, "cancel_order", {"order_id": order.id})
    assert payload["order"]["status"] == "cancelled"
    assert context.business_receipts[-1].expected_status == "cancelled"


def test_confirm_order_insufficient_inventory(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    order = create_buyout_order(context, key="big", quantity=5)  # pending 可超库存
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "confirm_order",
        {"order_id": order.id},
    )
    assert payload == {"ok": False, "error": "insufficient_inventory"}
    assert context.business_receipts[-1].error == "insufficient_inventory"


# ---------------------------------------------------------------- create_handoff


def test_create_handoff_tool_returns_bare_receipt(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores, message=" 请转人工 ")
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "create_handoff",
        {"reason": "需要人工授权", "context": "模型侧判断"},
    )
    assert set(payload) == {"support_request_id", "status"}  # 无 ok 包装
    assert payload["status"] == "open"
    assert context.support_request_id == payload["support_request_id"]
    stored = stores.support.get(payload["support_request_id"])
    assert stored.context == "请转人工"  # 客户消息
    assert stored.model_context == "模型侧判断"  # 模型的 context 参数


def test_create_handoff_tool_failure_is_swallowed(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    payload = run_tool(
        context,
        ToolExecutionState(),
        make_knowledge(stores, tmp_path),
        "create_handoff",
        {"reason": "", "context": "x"},
    )
    assert payload == {"ok": False, "error": "handoff receipt could not be persisted"}
    assert context.prior_actions == ["create_handoff:failed"]
    assert len(context.business_receipts) == 1
    assert context.business_receipts[0].error == "handoff receipt could not be persisted"
    assert context.support_request_id is None


# ---------------------------------------------------------------- artifacts


def test_save_research_artifact_requires_searched_sources(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    payload = run_tool(
        context,
        ToolExecutionState(),  # 本次 run 未检索过任何知识
        make_knowledge(stores, tmp_path),
        "save_research_artifact",
        research_args(),
    )
    assert payload == {
        "ok": False,
        "error": "artifact_source_not_searched:kb-return-policy",
    }
    assert context.prior_actions == ["save_research_artifact:failed"]
    assert context.business_receipts[-1].error == (
        "artifact_source_not_searched:kb-return-policy"
    )
    assert context.artifacts.list(context.customer_id) == []  # 未落库


def test_save_research_artifact_success_after_search(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    seed_state(state, "kb-return-policy")
    payload = run_tool(context, state, knowledge, "save_research_artifact", research_args())
    assert payload["ok"] is True
    assert payload["artifact"]["status"] == "review_pending"
    assert payload["artifact"]["kind"] == "research"
    assert payload["artifact"]["owner_id"] == context.customer_id
    assert payload["artifact"]["relations"][0]["from"] == "n1"  # 别名序列化
    assert payload["review"]["passed"] is True
    receipt = context.business_receipts[-1]
    assert receipt.artifact_id == payload["artifact"]["id"]
    assert receipt.expected_artifact_status == "review_pending"
    # 溯源状态是 run 级内存态：新 run 的空 state 直接拒绝相同 payload。
    fresh_context = make_context(stores, session_id="session-2")
    fresh_payload = run_tool(
        fresh_context,
        ToolExecutionState(),
        knowledge,
        "save_research_artifact",
        research_args(key="rs-2"),
    )
    assert fresh_payload["error"] == "artifact_source_not_searched:kb-return-policy"


def test_save_research_artifact_rejects_from_underscore_relation_key(tmp_path):
    """relation 输入只接受别名 "from"；未声明键 "from_" → invalid_tool_input。"""
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    seed_state(state, "kb-return-policy")
    args = research_args()
    args["relations"] = [{"from_": "n1", "to": "n1", "type": "self", "claim_id": "c1"}]
    payload = run_tool(context, state, knowledge, "save_research_artifact", args)
    assert payload["ok"] is False
    assert context.prior_actions == ["save_research_artifact:failed"]
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]
    assert context.artifacts.list(context.customer_id) == []  # 未落库
    # 别名 "from" 仍被接受。
    accepted = run_tool(context, state, knowledge, "save_research_artifact", research_args())
    assert accepted["ok"] is True


def test_save_research_artifact_review_failure_persists_review_failed(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    seed_state(state, "kb-return-policy")
    args = research_args()
    args["relations"] = [{"from": "n1", "to": "missing", "type": "rel", "claim_id": "c1"}]
    payload = run_tool(
        context, state, make_knowledge(stores, tmp_path), "save_research_artifact", args
    )
    assert payload["ok"] is False
    assert payload["error"] == "artifact_review_failed:relation_requires_nodes:n1:missing"
    persisted = context.artifacts.list(context.customer_id)
    assert [artifact.status for artifact in persisted] == ["review_failed"]
    assert context.business_receipts[-1].ok is False


def test_save_content_artifact_flow(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    seed_state(state, "kb-return-policy")
    research = run_tool(context, state, knowledge, "save_research_artifact", research_args())
    research_id = research["artifact"]["id"]
    content_args = {
        "idempotency_key": "ct-1",
        "research_artifact_id": research_id,
        "title": "渠道内容草稿",
        "channels": [
            {
                "channel": "xiaohongshu",
                "title": "西装租赁贴士",
                "body": "西装支持七天退货。",
                "claim_ids": ["c1"],
            }
        ],
    }
    payload = run_tool(context, state, knowledge, "save_content_artifact", content_args)
    assert payload["ok"] is True
    assert payload["artifact"]["kind"] == "content"
    assert payload["artifact"]["status"] == "review_pending"
    assert payload["artifact"]["research_artifact_id"] == research_id
    receipt = context.business_receipts[-1]
    assert receipt.expected_artifact_status == "review_pending"
    # claim 不在父 research → review 失败
    bad_args = {
        **content_args,
        "idempotency_key": "ct-2",
        "channels": [
            {
                "channel": "douyin",
                "title": "标题",
                "body": "正文",
                "claim_ids": ["missing"],
            }
        ],
    }
    bad = run_tool(context, state, knowledge, "save_content_artifact", bad_args)
    assert bad["ok"] is False
    assert bad["error"] == "artifact_review_failed:content_claim_not_in_research:missing"


def test_export_artifact_requires_approval_then_succeeds(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    seed_state(state, "kb-return-policy")
    research = run_tool(context, state, knowledge, "save_research_artifact", research_args())
    artifact_id = research["artifact"]["id"]
    export_args = {"artifact_id": artifact_id, "target": "sandbox"}
    payload = run_tool(context, state, knowledge, "export_artifact", export_args)
    assert payload == {"ok": False, "error": "artifact_not_approved"}
    context.artifacts.approve(artifact_id, "reviewer-1", context.customer_id)
    payload = run_tool(context, state, knowledge, "export_artifact", export_args)
    assert payload["ok"] is True
    delivery = payload["delivery"]
    assert delivery["artifact_id"] == artifact_id
    assert delivery["target"] == "sandbox"
    receipt = context.business_receipts[-1]
    assert receipt.delivery_id == delivery["id"]
    assert receipt.expected_content_hash == delivery["content_hash"]
    # 重复导出幂等返回既有 delivery；verify 用 SQLite 重读闭环。
    replay = run_tool(context, state, knowledge, "export_artifact", export_args)
    assert replay["delivery"]["id"] == delivery["id"]
    assert context.verify_business_outcome() == (
        "verified",
        f"delivery:{delivery['id']}:{delivery['content_hash']}",
    )


def test_export_artifact_hidden_for_other_owner(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    knowledge = make_knowledge(stores, tmp_path)
    seed_state(state, "kb-return-policy")
    research = run_tool(context, state, knowledge, "save_research_artifact", research_args())
    artifact_id = research["artifact"]["id"]
    context.artifacts.approve(artifact_id, "reviewer-1", context.customer_id)
    stranger = make_context(stores, customer_id="customer-b", session_id="session-b")
    payload = run_tool(
        stranger,
        ToolExecutionState(),
        knowledge,
        "export_artifact",
        {"artifact_id": artifact_id, "target": "sandbox"},
    )
    assert payload == {"ok": False, "error": artifact_id}  # ArtifactNotFound：消息即 id
    assert stranger.business_receipts[-1].ok is False


# ---------------------------------------------------------------- SDK 路径


async def test_sdk_tool_validation_failure_records_invalid_tool_input(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    tools = build_chatty_tools(
        state=ToolExecutionState(), knowledge_store=make_knowledge(stores, tmp_path)
    )
    tool = next(t for t in tools if t.name == "create_order")
    arguments = json.dumps({"idempotency_key": ""})
    tool_ctx = ToolContext(
        context=context,
        tool_name="create_order",
        tool_call_id="call_1",
        tool_arguments=arguments,
    )
    output = await tool.on_invoke_tool(tool_ctx, arguments)
    payload = json.loads(output)
    assert payload["ok"] is False
    # SDK 层校验失败也只记一条失败回执 + 一条 prior_action。
    assert context.prior_actions == ["create_order:failed"]
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]


async def test_sdk_tool_success_path_uses_raw_arguments(tmp_path):
    stores = make_stores(tmp_path)
    context = make_context(stores)
    state = ToolExecutionState()
    tools = build_chatty_tools(state=state, knowledge_store=make_knowledge(stores, tmp_path))
    tool = next(t for t in tools if t.name == "check_availability")
    arguments = json.dumps(
        {
            "product_id": "SUIT-001",
            "size": "M",
            "fulfillment_mode": "buyout",
            "quantity": 1,
            "start_date": None,
            "end_date": None,
        }
    )
    tool_ctx = ToolContext(
        context=context,
        tool_name="check_availability",
        tool_call_id="call_1",
        tool_arguments=arguments,
    )
    payload = json.loads(await tool.on_invoke_tool(tool_ctx, arguments))
    assert payload["ok"] is True
    assert payload["availability"]["available"] is True
    assert context.prior_actions == ["check_availability:ok"]
