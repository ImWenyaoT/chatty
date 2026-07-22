"""12 个 tools 的直接测试：权限边界、幂等前缀、回执、干净失败语义（无 LLM）。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any, get_args

import pytest
from agents.strict_schema import ensure_strict_json_schema
from agents.tool_context import ToolContext
from pydantic import BaseModel, ConfigDict, Field

from chatty.commerce import CreateOrderInput
from chatty.contracts import KnowledgeRecord, KnowledgeSearchResult, Order
from chatty.harness import AgentContext
from chatty.runtime import NativeRuntime
from chatty.tools import (
    _TOOL_SPECS,
    CHATTY_TOOL_NAMES,
    TOOL_DESCRIPTIONS,
    _params_signature,
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


@pytest.fixture
def runtime(tmp_path: Path) -> Iterator[NativeRuntime]:
    """生产拓扑：六个 store 共用一个 SQLite 文件，knowledge 复用 commerce 的连接句柄。

    单元测试实例化的就是这个聚合根本身，不再自建"每个 store 一个文件"的私有拓扑：
    跨 store 的事务/写锁交互因此被真正跑到，而不是被绕开。
    """
    native_runtime = NativeRuntime(tmp_path / "chatty.sqlite")
    source = tmp_path / "kb.jsonl"
    source.write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in KB_RECORDS),
        encoding="utf-8",
    )
    native_runtime.knowledge.import_jsonl(source)
    try:
        yield native_runtime
    finally:
        native_runtime.close()


def make_context(
    runtime: NativeRuntime,
    *,
    message: str = "你好，请帮我处理订单。",
    customer_id: str = "customer-demo",
    session_id: str = "session-1",
    request_id: str = "request-1",
    knowledge: Any = None,
) -> AgentContext:
    trace_id = f"trace_{uuid.uuid4().hex}"
    runtime.traces.start(trace_id, session_id, "test-model")
    return AgentContext(
        customer_id=customer_id,
        session_id=session_id,
        commerce=runtime.commerce,
        artifacts=runtime.artifacts,
        message=message,
        trace_id=trace_id,
        request_id=request_id,
        knowledge=runtime.knowledge if knowledge is None else knowledge,
        memory_store=runtime.memory,
        support_store=runtime.support,
        trace_store=runtime.traces,
    )


class _StubKnowledgeStore:
    """duck-typed 检索桩：只需要 search(query, limit=...)。"""

    def __init__(self, result: KnowledgeSearchResult) -> None:
        self._result = result

    def search(self, query: str, *, limit: int) -> KnowledgeSearchResult:
        return self._result


def run_tool(
    context: AgentContext,
    tool_name: str,
    arguments: dict[str, Any] | str,
) -> dict[str, Any]:
    return json.loads(
        execute_chatty_tool(context=context, tool_name=tool_name, arguments=arguments)
    )


def seed_search_results(context: AgentContext, *record_ids: str) -> None:
    """伪装成本次 run 已检索过这些知识 id（source 溯源不变量的前置条件）。"""
    for record_id in record_ids:
        context.knowledge_search_results[record_id] = KnowledgeRecord(
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


def test_tool_declarations_match_spec():
    # 构造不吃 run 级状态，因此这两个 schema 测试连 runtime 都不需要。
    tools = build_chatty_tools()
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


def test_sdk_schema_is_derived_from_params_model():
    """漂移守卫：12 个 tool 发布给模型的 strict schema 必须等于 params model 的 schema。

    SDK 层与 Harness 层的约束只在 params model 里声明一次；`build_chatty_tools`
    把字段翻译成函数签名后交给 openai-agents 生成 schema。任何一层单方面改约束
    （放宽 max_length、增删字段、改默认值）都会在这里失败。

    唯一允许的差异是 title：SDK 把动态参数 model 命名为 `{tool}_args`，pydantic
    用类名（且 OrderIdParams 被三个 tool 复用，类名本就无法一一对应）。
    """
    tools = build_chatty_tools()
    by_name = {tool.name: tool for tool in tools}
    assert set(by_name) == set(_TOOL_SPECS)
    for name, spec in _TOOL_SPECS.items():
        expected = ensure_strict_json_schema(spec.params_model.model_json_schema())
        expected["title"] = f"{name}_args"
        assert by_name[name].params_json_schema == expected, name
    # 派生前 StringConstraints 会被 SDK 静默丢弃，这两个字段曾只有 Harness 层设限。
    memory_query = by_name["search_customer_memory"].params_json_schema["properties"]["query"]
    assert (memory_query["minLength"], memory_query["maxLength"]) == (1, 200)
    memory_fact = by_name["save_customer_memory"].params_json_schema["properties"]["fact"]
    assert (memory_fact["minLength"], memory_fact["maxLength"]) == (1, 500)


def test_params_signature_carries_constraints_and_defaults():
    """签名翻译保真：约束、默认值、字段顺序都来自 params model。"""

    class _Params(BaseModel):
        model_config = ConfigDict(extra="forbid")

        required_after_default: str = Field(min_length=2, max_length=8)
        with_default: int = Field(default=7, ge=1, le=9)
        tail: str = Field(min_length=1)

    signature, annotations = _params_signature(_Params)
    names = list(signature.parameters)
    assert names == ["ctx", "required_after_default", "with_default", "tail"]
    # 默认值只留在 FieldInfo 里，签名参数一律无默认值，否则字段顺序会被迫重排。
    assert all(signature.parameters[name].default is signature.empty for name in names)
    assert set(annotations) == {*names, "return"}
    # 约束与默认值随 FieldInfo 一起挂进 Annotated 元数据，SDK 由此还原同一套限制。
    carried = get_args(annotations["with_default"])[1]
    assert carried is _Params.model_fields["with_default"]
    assert carried.default == 7


def test_params_signature_rejects_top_level_alias():
    """顶层字段用 alias 会让签名参数名与对外键名分叉——直接拒绝，不产出第二份声明。"""

    class _Aliased(BaseModel):
        model_config = ConfigDict(extra="forbid")

        from_: str = Field(alias="from")

    with pytest.raises(ValueError, match="must not use an alias"):
        _params_signature(_Aliased)


def test_execute_chatty_tool_rejects_unknown_tool(runtime):
    with pytest.raises(ValueError, match="unknown_tool:nope"):
        execute_chatty_tool(
            context=make_context(runtime),
            tool_name="nope",
            arguments={},
        )


# ---------------------------------------------------------------- search_knowledge


def test_search_knowledge_accumulates_run_state(runtime):
    context = make_context(runtime)
    payload = run_tool(context, "search_knowledge", {"query": "退货政策"})
    assert "ok" not in payload  # 无 ok 包装
    assert payload["status"] == "ok"
    assert payload["query"] == "退货政策"
    assert payload["error"] is None
    assert any(record["id"] == "kb-return-policy" for record in payload["results"])
    assert "kb-return-policy" in context.knowledge_search_results
    assert context.prior_actions == ["search_knowledge:ok"]
    assert context.business_receipts == []  # 纯检索成功不产生回执（§6.3）
    run_tool(context, "search_knowledge", {"query": "西装保养指南"})
    assert {"kb-return-policy", "kb-suit-care"} <= set(context.knowledge_search_results)


def test_search_knowledge_error_status_prior_action(runtime):
    stub = _StubKnowledgeStore(
        KnowledgeSearchResult(
            status="error", query="q", results=[], error="knowledge_search_unavailable"
        )
    )
    context = make_context(runtime, knowledge=stub)
    payload = run_tool(context, "search_knowledge", {"query": "q"})
    assert payload["error"] == "knowledge_search_unavailable"
    assert context.prior_actions == ["search_knowledge:error"]
    assert context.business_receipts == []


def test_search_knowledge_invalid_params_record_invalid_tool_input(runtime):
    context = make_context(runtime)
    payload = run_tool(context, "search_knowledge", {"query": ""})
    assert payload["ok"] is False
    assert context.prior_actions == ["search_knowledge:failed"]
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]


# ---------------------------------------------------------------- customer memory


def test_save_customer_memory_verbatim_casefold(runtime):
    context = make_context(runtime, message="请记住我的会员名是 STRASSE，谢谢")
    raw = execute_chatty_tool(
        context=context,
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
    persisted = runtime.memory.search(customer_id=context.customer_id, query="straße", limit=5)
    assert [memory.fact for memory in persisted] == ["straße"]


def test_save_customer_memory_rejects_non_verbatim_fact(runtime):
    context = make_context(runtime, message="今天天气不错")
    payload = run_tool(
        context,
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


def test_save_customer_memory_requires_literal_true_flags(runtime):
    context = make_context(runtime, message="记住我的地址")
    payload = run_tool(
        context,
        "save_customer_memory",
        {"fact": "记住我的地址", "explicitly_stated": False, "stable": True},
    )
    assert payload["ok"] is False
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]


def test_search_customer_memory_returns_event(runtime):
    context = make_context(runtime)
    runtime.memory.save(customer_id=context.customer_id, fact="常住上海", source_id="trace-x")
    payload = run_tool(context, "search_customer_memory", {"query": "常住上海"})
    assert payload["tool"] == "search_customer_memory"
    assert [memory["fact"] for memory in payload["memories"]] == ["常住上海"]
    assert context.prior_actions == ["search_customer_memory:ok"]
    assert len(context.memory_events) == 1
    assert context.business_receipts == []


# ---------------------------------------------------------------- 订单 tools


def test_check_availability_records_read_receipt(runtime):
    context = make_context(runtime)
    payload = run_tool(
        context,
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


def test_check_availability_unknown_variant(runtime):
    context = make_context(runtime)
    payload = run_tool(
        context,
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


def test_create_order_injects_identity_and_prefixes_idempotency(runtime):
    context = make_context(runtime)
    payload = run_tool(context, "create_order", ORDER_ARGS)
    assert payload["ok"] is True
    order = payload["order"]
    assert order["customer_id"] == context.customer_id
    assert order["session_id"] == context.session_id
    assert order["status"] == "pending"
    assert order["channel"] == "Chatty"  # 省略时应用默认值
    row = runtime.commerce.database.execute("SELECT idempotency_key FROM orders").fetchone()
    assert row["idempotency_key"] == f"{context.session_id}:order-key"
    receipt = context.business_receipts[-1]
    assert (receipt.order_id, receipt.expected_status) == (order["id"], "pending")
    # 幂等重放返回同一订单
    replay = run_tool(context, "create_order", ORDER_ARGS)
    assert replay["order"]["id"] == order["id"]
    count = runtime.commerce.database.execute("SELECT COUNT(*) AS n FROM orders").fetchone()
    assert count["n"] == 1


def test_create_order_rejects_injected_identity_fields(runtime):
    context = make_context(runtime)
    payload = run_tool(context, "create_order", {**ORDER_ARGS, "customer_id": "attacker"})
    assert payload["ok"] is False
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]
    assert context.prior_actions == ["create_order:failed"]


def test_create_order_rental_cross_validation_in_store_layer(runtime):
    context = make_context(runtime)
    # rental 缺日期
    payload = run_tool(context, "create_order", {**ORDER_ARGS, "fulfillment_mode": "rental"})
    assert payload["ok"] is False
    assert "invalid_rental_period" in payload["error"]
    assert context.business_receipts[-1].error == "invalid_tool_input"


def test_order_tools_hide_other_customers_orders(runtime):
    owner = make_context(runtime, customer_id="customer-a", session_id="session-a")
    order = create_buyout_order(owner)
    stranger = make_context(runtime, customer_id="customer-b", session_id="session-b")
    for tool_name in ("view_order", "confirm_order", "cancel_order"):
        payload = run_tool(stranger, tool_name, {"order_id": order.id})
        assert payload == {"ok": False, "error": "order_not_found"}
    assert stranger.prior_actions == [
        "view_order:failed",
        "confirm_order:failed",
        "cancel_order:failed",
    ]
    # 归属者可读，回执带证据。
    payload = run_tool(owner, "view_order", {"order_id": order.id})
    assert payload["ok"] is True
    assert owner.business_receipts[-1].evidence == f"view_order:{order.id}:pending"


def test_confirm_and_cancel_order_record_status(runtime):
    context = make_context(runtime)
    order = create_buyout_order(context)
    payload = run_tool(context, "confirm_order", {"order_id": order.id})
    assert payload["order"]["status"] == "confirmed"
    assert context.business_receipts[-1].expected_status == "confirmed"
    payload = run_tool(context, "cancel_order", {"order_id": order.id})
    assert payload["order"]["status"] == "cancelled"
    assert context.business_receipts[-1].expected_status == "cancelled"


def test_confirm_order_insufficient_inventory(runtime):
    context = make_context(runtime)
    order = create_buyout_order(context, key="big", quantity=5)  # pending 可超库存
    payload = run_tool(context, "confirm_order", {"order_id": order.id})
    assert payload == {"ok": False, "error": "insufficient_inventory"}
    assert context.business_receipts[-1].error == "insufficient_inventory"


# ---------------------------------------------------------------- create_handoff


def test_create_handoff_tool_returns_bare_receipt(runtime):
    context = make_context(runtime, message=" 请转人工 ")
    payload = run_tool(
        context, "create_handoff", {"reason": "需要人工授权", "context": "模型侧判断"}
    )
    assert set(payload) == {"support_request_id", "status"}  # 无 ok 包装
    assert payload["status"] == "open"
    assert context.support_request_id == payload["support_request_id"]
    stored = runtime.support.get(payload["support_request_id"])
    assert stored.context == "请转人工"  # 客户消息
    assert stored.model_context == "模型侧判断"  # 模型的 context 参数
    # 唯一一个成功时不记 prior_action 的 tool（ToolOutcome.status=None）：receipt 里
    # 已经存了这次 run 到此为止的整份 prior_actions，再追加等于把 handoff 记进自己。
    assert context.prior_actions == []
    assert stored.prior_actions == []


def test_create_handoff_tool_failure_is_swallowed(runtime):
    context = make_context(runtime)
    payload = run_tool(context, "create_handoff", {"reason": "", "context": "x"})
    assert payload == {"ok": False, "error": "handoff receipt could not be persisted"}
    assert context.prior_actions == ["create_handoff:failed"]
    assert len(context.business_receipts) == 1
    assert context.business_receipts[0].error == "handoff receipt could not be persisted"
    assert context.support_request_id is None


# ---------------------------------------------------------------- artifacts


def test_save_research_artifact_requires_searched_sources(runtime):
    context = make_context(runtime)
    payload = run_tool(context, "save_research_artifact", research_args())
    assert payload == {
        "ok": False,
        "error": "artifact_source_not_searched:kb-return-policy",
    }
    assert context.prior_actions == ["save_research_artifact:failed"]
    assert context.business_receipts[-1].error == ("artifact_source_not_searched:kb-return-policy")
    assert context.artifacts.list(context.customer_id) == []  # 未落库


def test_save_research_artifact_success_after_search(runtime):
    context = make_context(runtime)
    seed_search_results(context, "kb-return-policy")
    payload = run_tool(context, "save_research_artifact", research_args())
    assert payload["ok"] is True
    assert payload["artifact"]["status"] == "review_pending"
    assert payload["artifact"]["kind"] == "research"
    assert payload["artifact"]["owner_id"] == context.customer_id
    assert payload["artifact"]["relations"][0]["from"] == "n1"  # 别名序列化
    assert payload["review"]["passed"] is True
    receipt = context.business_receipts[-1]
    assert receipt.artifact_id == payload["artifact"]["id"]
    assert receipt.expected_artifact_status == "review_pending"
    # 溯源状态是 run 级内存态，随 context 走：新 run 的空 context 直接拒绝相同 payload。
    fresh_context = make_context(runtime, session_id="session-2")
    fresh_payload = run_tool(fresh_context, "save_research_artifact", research_args(key="rs-2"))
    assert fresh_payload["error"] == "artifact_source_not_searched:kb-return-policy"


def test_save_research_artifact_rejects_from_underscore_relation_key(runtime):
    """relation 输入只接受别名 "from"；未声明键 "from_" → invalid_tool_input。"""
    context = make_context(runtime)
    seed_search_results(context, "kb-return-policy")
    args = research_args()
    args["relations"] = [{"from_": "n1", "to": "n1", "type": "self", "claim_id": "c1"}]
    payload = run_tool(context, "save_research_artifact", args)
    assert payload["ok"] is False
    assert context.prior_actions == ["save_research_artifact:failed"]
    assert [receipt.error for receipt in context.business_receipts] == ["invalid_tool_input"]
    assert context.artifacts.list(context.customer_id) == []  # 未落库
    # 别名 "from" 仍被接受。
    accepted = run_tool(context, "save_research_artifact", research_args())
    assert accepted["ok"] is True


def test_save_research_artifact_review_failure_persists_review_failed(runtime):
    context = make_context(runtime)
    seed_search_results(context, "kb-return-policy")
    args = research_args()
    args["relations"] = [{"from": "n1", "to": "missing", "type": "rel", "claim_id": "c1"}]
    payload = run_tool(context, "save_research_artifact", args)
    assert payload["ok"] is False
    assert payload["error"] == "artifact_review_failed:relation_requires_nodes:n1:missing"
    persisted = context.artifacts.list(context.customer_id)
    assert [artifact.status for artifact in persisted] == ["review_failed"]
    assert context.business_receipts[-1].ok is False


def test_save_content_artifact_flow(runtime):
    context = make_context(runtime)
    seed_search_results(context, "kb-return-policy")
    research = run_tool(context, "save_research_artifact", research_args())
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
    payload = run_tool(context, "save_content_artifact", content_args)
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
    bad = run_tool(context, "save_content_artifact", bad_args)
    assert bad["ok"] is False
    assert bad["error"] == "artifact_review_failed:content_claim_not_in_research:missing"


def test_export_artifact_requires_approval_then_succeeds(runtime):
    context = make_context(runtime)
    seed_search_results(context, "kb-return-policy")
    research = run_tool(context, "save_research_artifact", research_args())
    artifact_id = research["artifact"]["id"]
    export_args = {"artifact_id": artifact_id, "target": "sandbox"}
    payload = run_tool(context, "export_artifact", export_args)
    assert payload == {"ok": False, "error": "artifact_not_approved"}
    context.artifacts.approve(artifact_id, "reviewer-1", context.customer_id)
    payload = run_tool(context, "export_artifact", export_args)
    assert payload["ok"] is True
    delivery = payload["delivery"]
    assert delivery["artifact_id"] == artifact_id
    assert delivery["target"] == "sandbox"
    receipt = context.business_receipts[-1]
    assert receipt.delivery_id == delivery["id"]
    assert receipt.expected_content_hash == delivery["content_hash"]
    # 重复导出幂等返回既有 delivery；verify 用 SQLite 重读闭环。
    replay = run_tool(context, "export_artifact", export_args)
    assert replay["delivery"]["id"] == delivery["id"]
    assert context.verify_business_outcome() == (
        "verified",
        f"delivery:{delivery['id']}:{delivery['content_hash']}",
    )


def test_export_artifact_hidden_for_other_owner(runtime):
    context = make_context(runtime)
    seed_search_results(context, "kb-return-policy")
    research = run_tool(context, "save_research_artifact", research_args())
    artifact_id = research["artifact"]["id"]
    context.artifacts.approve(artifact_id, "reviewer-1", context.customer_id)
    stranger = make_context(runtime, customer_id="customer-b", session_id="session-b")
    payload = run_tool(
        stranger, "export_artifact", {"artifact_id": artifact_id, "target": "sandbox"}
    )
    assert payload == {"ok": False, "error": artifact_id}  # ArtifactNotFound：消息即 id
    assert stranger.business_receipts[-1].ok is False


# ---------------------------------------------------------------- SDK 路径


async def test_sdk_tool_validation_failure_records_invalid_tool_input(runtime):
    context = make_context(runtime)
    tools = build_chatty_tools()
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


async def test_sdk_tool_success_path_uses_raw_arguments(runtime):
    context = make_context(runtime)
    tools = build_chatty_tools()
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
