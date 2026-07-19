import json
import sqlite3
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from agents import Model, ModelResponse, ModelSettings, ModelTracing, Usage
from agents.agent_output import AgentOutputSchemaBase
from agents.handoffs import Handoff
from agents.items import TResponseInputItem, TResponseOutputItem, TResponseStreamEvent
from agents.tool import FunctionTool, Tool
from fastapi.testclient import TestClient
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)

from chatty.agent import create_handoff
from chatty.app import create_app


def customer_identity(customer_id: str):
    return lambda: customer_id


class ScriptedModel(Model):
    def __init__(self, replies: list[str | ResponseFunctionToolCall | list[Any]]) -> None:
        self.replies = iter(replies)
        self.inputs: list[str | list[TResponseInputItem]] = []
        self.settings: list[ModelSettings] = []
        self.tracings: list[ModelTracing] = []
        self.tool_names: list[list[str]] = []
        self.tool_schemas: list[dict[str, dict[str, Any]]] = []

    async def get_response(
        self,
        system_instructions: str | None,
        input: str | list[TResponseInputItem],
        model_settings: ModelSettings,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None,
        conversation_id: str | None,
        prompt: Any,
    ) -> ModelResponse:
        self.inputs.append(input)
        self.settings.append(model_settings)
        self.tracings.append(tracing)
        self.tool_names.append([tool.name for tool in tools])
        self.tool_schemas.append(
            {tool.name: tool.params_json_schema for tool in tools if isinstance(tool, FunctionTool)}
        )
        reply = next(self.replies)
        output: list[TResponseOutputItem]
        if isinstance(reply, ResponseFunctionToolCall):
            output = [reply]
        elif isinstance(reply, list):
            output = reply
        else:
            output = [
                ResponseOutputMessage(
                    id=f"message-{len(self.inputs)}",
                    content=[ResponseOutputText(annotations=[], text=reply, type="output_text")],
                    role="assistant",
                    status="completed",
                    type="message",
                )
            ]
        return ModelResponse(
            output=output,
            usage=Usage(),
            response_id=None,
        )

    def stream_response(
        self,
        system_instructions: str | None,
        input: str | list[TResponseInputItem],
        model_settings: ModelSettings,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None,
        conversation_id: str | None,
        prompt: Any,
    ) -> AsyncIterator[TResponseStreamEvent]:
        raise NotImplementedError


def test_health_reports_service_ready(tmp_path: Path) -> None:
    with TestClient(create_app(database_path=tmp_path / "chatty.sqlite")) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_user_can_continue_an_agent_session_and_receive_local_trace_summary(
    tmp_path: Path,
) -> None:
    model = ScriptedModel(["你好，小林。", "你刚才说你叫小林。"])
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=model,
        model_id="controllable-test-model",
        customer_identity=customer_identity("trusted-customer"),
    )

    with TestClient(app) as client:
        first = client.post("/runs", json={"message": "我叫小林"})
        first_body = first.json()
        second = client.post(
            "/runs",
            json={"message": "我刚才说我叫什么？", "session_id": first_body["session_id"]},
        )
        trace = client.get(f"/traces/{second.json()['trace_id']}")

    assert first.status_code == 200
    assert first_body["reply"] == "你好，小林。"
    assert first_body["status"] == "responded"
    assert first_body["business_outcome"] == "not_applicable"
    assert first_body["request_id"].startswith("request_")
    assert first_body["session_id"].startswith("session_")
    assert first_body["trace_id"].startswith("trace_")
    assert second.status_code == 200
    assert second.json()["reply"] == "你刚才说你叫小林。"
    assert second.json()["session_id"] == first_body["session_id"]
    assert "我叫小林" in json.dumps(model.inputs[1], ensure_ascii=False)
    assert "你好，小林。" in json.dumps(model.inputs[1], ensure_ascii=False)
    assert model.settings[0].extra_body == {"thinking": {"type": "disabled"}}
    assert model.tracings[0] is ModelTracing.ENABLED_WITHOUT_DATA
    assert trace.status_code == 200
    assert trace.json() == {
        "trace_id": second.json()["trace_id"],
        "session_id": first_body["session_id"],
        "status": "completed",
        "summary": "Agent run completed",
        "model_id": "controllable-test-model",
        "span_types": ["agent", "task", "turn"],
    }


def test_empty_model_output_forces_a_traceable_handoff(tmp_path: Path) -> None:
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=ScriptedModel([""]),
    )

    with TestClient(app) as client:
        response = client.post("/runs", json={"message": "你好"})

    assert response.status_code == 200
    assert response.json()["status"] == "needs_human"
    assert response.json()["support_request_id"].startswith("support_")


def test_model_can_search_real_knowledge_and_return_source_evidence(tmp_path: Path) -> None:
    knowledge_path = tmp_path / "knowledge.jsonl"
    knowledge_path.write_text(
        json.dumps(
            {
                "id": "policy-rental-period-1",
                "title": "租期计算",
                "summary": "租期从签收当天开始。",
                "body": "租期从签收当天开始计算，到约定归还日期寄回即可。",
                "source": "seller-policy://rental-period",
                "tags": ["租赁"],
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"query": "租期", "limit": 2}, ensure_ascii=False),
                call_id="call-search-1",
                name="search_knowledge",
                status="completed",
                type="function_call",
            ),
            "租期从签收当天开始，到约定归还日期寄回即可。来源：seller-policy://rental-period",
        ]
    )
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        knowledge_path=knowledge_path,
        model=model,
    )

    with TestClient(app) as client:
        response = client.post("/runs", json={"message": "租期怎么算？"})
        trace = client.get(f"/traces/{response.json()['trace_id']}")

    assert response.status_code == 200
    assert "search_knowledge" in model.tool_names[0]
    query_schema = model.tool_schemas[0]["search_knowledge"]["properties"]["query"]
    assert query_schema["minLength"] == 1
    assert query_schema["maxLength"] == 500
    assert "seller-policy://rental-period" in json.dumps(model.inputs[1], ensure_ascii=False)
    assert "seller-policy://rental-period" in response.json()["reply"]
    assert response.json()["knowledge_search_results"] == [
        {
            "id": "policy-rental-period-1",
            "title": "租期计算",
            "summary": "租期从签收当天开始。",
            "body": "租期从签收当天开始计算，到约定归还日期寄回即可。",
            "source": "seller-policy://rental-period",
            "tags": ["租赁"],
        }
    ]
    assert "function" in trace.json()["span_types"]


def test_model_can_answer_a_product_question_from_search(tmp_path: Path) -> None:
    knowledge_path = tmp_path / "knowledge.jsonl"
    knowledge_path.write_text(
        json.dumps(
            {
                "id": "product-suit-001-1",
                "title": "SUIT-001 黑色双排扣西装",
                "summary": "首日租金 199 元。",
                "body": "SUIT-001 第一天租赁价格 199 元。",
                "source": "seller-catalog://SUIT-001",
                "tags": ["商品", "价格"],
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"query": "SUIT-001 价格", "limit": 1}),
                call_id="call-product-search",
                name="search_knowledge",
                status="completed",
                type="function_call",
            ),
            "SUIT-001 首日租金 199 元。来源：seller-catalog://SUIT-001",
        ]
    )

    with TestClient(
        create_app(
            database_path=tmp_path / "chatty.sqlite",
            knowledge_path=knowledge_path,
            model=model,
        )
    ) as client:
        response = client.post("/runs", json={"message": "SUIT-001 多少钱一天？"})

    assert response.status_code == 200
    assert response.json()["knowledge_search_results"][0]["id"] == "product-suit-001-1"
    assert "seller-catalog://SUIT-001" in response.json()["reply"]


def test_knowledge_backed_reply_without_a_source_is_not_completed(tmp_path: Path) -> None:
    knowledge_path = tmp_path / "knowledge.jsonl"
    knowledge_path.write_text(
        json.dumps(
            {
                "id": "policy-1",
                "title": "租期",
                "summary": "租期规则。",
                "body": "从签收日开始。",
                "source": "seller-policy://rental-period",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"query": "租期", "limit": 1}),
                call_id="call-source-check",
                name="search_knowledge",
                status="completed",
                type="function_call",
            ),
            "租期从签收日开始。",
        ]
    )

    with TestClient(
        create_app(
            database_path=tmp_path / "chatty.sqlite",
            knowledge_path=knowledge_path,
            model=model,
        )
    ) as client:
        response = client.post("/runs", json={"message": "租期怎么算？"})

    assert response.status_code == 502
    assert response.json() == {"detail": "llm_provider_failed"}


def test_search_failure_reaches_the_model_as_a_structured_tool_result(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.sqlite"
    knowledge_path = tmp_path / "knowledge.jsonl"
    knowledge_path.write_text(
        json.dumps(
            {
                "id": "policy-1",
                "title": "租期",
                "summary": "租期规则。",
                "body": "从签收日开始。",
                "source": "seller-policy://rental-period",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"query": "租期", "limit": 2}),
                call_id="call-failed-search",
                name="search_knowledge",
                status="completed",
                type="function_call",
            ),
            "知识搜索暂时不可用，请稍后重试。",
        ]
    )
    app = create_app(database_path=database_path, knowledge_path=knowledge_path, model=model)
    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP TABLE knowledge_fts")

    with TestClient(app) as client:
        response = client.post("/runs", json={"message": "租期怎么算？"})

    assert response.status_code == 200
    assert "knowledge_search_unavailable" in json.dumps(model.inputs[1], ensure_ascii=False)
    assert response.json()["knowledge_search_results"] == []


def test_model_selected_order_tool_persists_state_read_by_fastapi(tmp_path: Path) -> None:
    arguments = json.dumps(
        {
            "idempotency_key": "customer-request-1",
            "product_id": "SUIT-001",
            "size": "L",
            "fulfillment_mode": "rental",
            "quantity": 1,
            "start_date": "2026-08-01",
            "end_date": "2026-08-03",
            "amount_cents": 76000,
            "channel": "Chatty",
            "address": "上海市静安区",
            "risk": "无",
        }
    )
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=arguments,
                call_id="call-create-order",
                name="create_order",
                type="function_call",
            ),
            "订单已创建，等待确认。",
        ]
    )
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=model,
        model_id="controllable-test-model",
        customer_identity=customer_identity("trusted-customer"),
    )

    with TestClient(app) as client:
        run = client.post(
            "/runs",
            json={
                "message": "请预订 8 月 1 日到 3 日的 L 码西装",
                "customer_id": "trusted-customer",
                "session_id": "trusted-session",
            },
        )
        orders = client.get("/orders")
        order_id = orders.json()[0]["id"]
        detail = client.get(f"/orders/{order_id}")

    assert run.status_code == 200
    assert run.json()["reply"] == "订单已创建，等待确认。"
    assert run.json()["business_outcome"] == "verified"
    assert run.json()["completion_evidence"].startswith("create_order:order_")
    assert set(
        [
            "check_availability",
            "create_order",
            "view_order",
            "confirm_order",
            "cancel_order",
        ]
    ).issubset(model.tool_names[0])
    assert orders.status_code == 200
    assert len(orders.json()) == 1
    assert detail.status_code == 200
    assert detail.json()["customer_id"] == "trusted-customer"
    assert detail.json()["session_id"] == "trusted-session"
    assert detail.json()["status"] == "pending"
    assert [event["event_type"] for event in detail.json()["events"]] == ["created"]
    assert "order_" in json.dumps(model.inputs[1], ensure_ascii=False)


def test_order_detail_returns_not_found_for_unknown_order(tmp_path: Path) -> None:
    with TestClient(create_app(database_path=tmp_path / "chatty.sqlite")) as client:
        response = client.get("/orders/missing")

    assert response.status_code == 404
    assert response.json() == {"detail": "order_not_found"}


def test_failed_order_tool_cannot_be_reported_as_a_verified_business_outcome(
    tmp_path: Path,
) -> None:
    arguments = json.dumps(
        {
            "idempotency_key": "unknown-variant",
            "product_id": "SUIT-001",
            "size": "XXL",
            "fulfillment_mode": "buyout",
            "quantity": 1,
            "start_date": None,
            "end_date": None,
            "amount_cents": 10000,
            "channel": "Chatty",
            "address": "上海市静安区",
            "risk": "无",
        }
    )
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=arguments,
                call_id="call-create-unknown",
                name="create_order",
                type="function_call",
            ),
            "订单已经创建成功。",
        ]
    )

    with TestClient(create_app(database_path=tmp_path / "chatty.sqlite", model=model)) as client:
        response = client.post(
            "/runs",
            json={"message": "买一件 XXL", "customer_id": "trusted-customer"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "not_completed"
    assert response.json()["business_outcome"] == "not_completed"
    assert response.json()["completion_evidence"] == "create_order:unknown_variant"
    assert response.json()["reply"] == "业务操作未完成：unknown_variant"


def test_inventory_tool_result_is_verified_business_evidence(tmp_path: Path) -> None:
    arguments = json.dumps(
        {
            "product_id": "SUIT-001",
            "size": "L",
            "fulfillment_mode": "buyout",
            "quantity": 1,
            "start_date": None,
            "end_date": None,
        }
    )
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=arguments,
                call_id="call-check-inventory",
                name="check_availability",
                type="function_call",
            ),
            "L 码有货。",
        ]
    )

    with TestClient(create_app(database_path=tmp_path / "chatty.sqlite", model=model)) as client:
        response = client.post("/runs", json={"message": "L 码能买吗？"})

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["business_outcome"] == "verified"
    assert response.json()["completion_evidence"] == ("check_availability:SUIT-001:L:available=2")


def test_explicit_stable_memory_is_searchable_across_sessions_with_provenance(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "chatty.sqlite"
    save_model = ScriptedModel(
        [
            [
                ResponseFunctionToolCall(
                    arguments=json.dumps(
                        {
                            "fact": "我对羊毛过敏",
                            "explicitly_stated": True,
                            "stable": True,
                        },
                        ensure_ascii=False,
                    ),
                    call_id="save-memory-1",
                    name="save_customer_memory",
                    type="function_call",
                )
            ],
            "我会记住你对羊毛过敏。",
        ]
    )
    save_app = create_app(
        database_path=database_path,
        model=save_model,
        model_id="memory-save-model",
        customer_identity=customer_identity("customer-1"),
    )

    with TestClient(save_app) as client:
        saved = client.post(
            "/runs",
            json={"message": "请记住，我对羊毛过敏"},
        )

    assert saved.status_code == 200
    saved_body = saved.json()
    assert saved_body["memory_events"][0]["tool"] == "save_customer_memory"
    saved_memory = saved_body["memory_events"][0]["memories"][0]
    assert saved_memory["customer_id"] == "customer-1"
    assert saved_memory["fact"] == "我对羊毛过敏"
    assert saved_memory["source_id"] == saved_body["trace_id"]
    assert saved_memory["created_at"].endswith("Z")

    search_model = ScriptedModel(
        [
            [
                ResponseFunctionToolCall(
                    arguments=json.dumps({"query": "羊毛", "limit": 5}, ensure_ascii=False),
                    call_id="search-memory-1",
                    name="search_customer_memory",
                    type="function_call",
                )
            ],
            "根据你之前明确提供的信息，你对羊毛过敏。",
        ]
    )
    search_app = create_app(
        database_path=database_path,
        model=search_model,
        model_id="memory-search-model",
        customer_identity=customer_identity("customer-1"),
    )

    with TestClient(search_app) as client:
        found = client.post(
            "/runs",
            json={"message": "帮我选合适的材质"},
        )

    other_model = ScriptedModel(
        [
            [
                ResponseFunctionToolCall(
                    arguments=json.dumps({"query": "羊毛", "limit": 5}, ensure_ascii=False),
                    call_id="other-customer-search-1",
                    name="search_customer_memory",
                    type="function_call",
                )
            ],
            "没有找到这位客户的相关记录。",
        ]
    )
    other_app = create_app(
        database_path=database_path,
        model=other_model,
        customer_identity=customer_identity("customer-2"),
    )
    with TestClient(other_app) as client:
        other_run = client.post(
            "/runs",
            json={"customer_id": "customer-1", "message": "帮我查羊毛偏好"},
        )
        other_customer = client.get("/memories", params={"query": "羊毛"})

    assert found.status_code == 200
    assert found.json()["reply"] == "根据你之前明确提供的信息，你对羊毛过敏。"
    assert found.json()["session_id"] != saved_body["session_id"]
    search_event = found.json()["memory_events"][0]
    assert search_event["tool"] == "search_customer_memory"
    assert search_event["memories"] == [saved_memory]
    assert "我对羊毛过敏" in json.dumps(search_model.inputs[1], ensure_ascii=False)
    assert saved_body["trace_id"] in json.dumps(search_model.inputs[1], ensure_ascii=False)
    assert other_customer.status_code == 200
    assert other_customer.json()["memories"] == []
    assert other_run.status_code == 200
    assert other_run.json()["customer_id"] == "customer-2"
    assert other_run.json()["memory_events"][0]["memories"] == []


def test_temporary_or_inferred_statement_cannot_be_saved_as_memory(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.sqlite"
    model = ScriptedModel(
        [
            [
                ResponseFunctionToolCall(
                    arguments=json.dumps(
                        {
                            "fact": "客户今天想租蓝色西装",
                            "explicitly_stated": False,
                            "stable": False,
                        },
                        ensure_ascii=False,
                    ),
                    call_id="invalid-memory-1",
                    name="save_customer_memory",
                    type="function_call",
                )
            ],
            "这只是本次需求，我不会把它保存为长期客户事实。",
        ]
    )
    app = create_app(
        database_path=database_path,
        model=model,
        customer_identity=customer_identity("customer-1"),
    )

    with TestClient(app) as client:
        run = client.post(
            "/runs",
            json={"message": "今天想租蓝色西装"},
        )
        memories = client.get("/memories", params={"query": "蓝色"})

    assert run.status_code == 200
    assert run.json()["memory_events"] == []
    assert "literal_error" in json.dumps(model.inputs[1], ensure_ascii=False)
    assert memories.status_code == 200
    assert memories.json()["memories"] == []


def test_memory_rejects_a_fact_not_quoted_from_the_customer_message(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.sqlite"
    model = ScriptedModel(
        [
            [
                ResponseFunctionToolCall(
                    arguments=json.dumps(
                        {
                            "fact": "客户偏爱羊毛",
                            "explicitly_stated": True,
                            "stable": True,
                        },
                        ensure_ascii=False,
                    ),
                    call_id="inferred-memory-1",
                    name="save_customer_memory",
                    type="function_call",
                )
            ],
            "你没有明确说过这项偏好，因此我不会保存。",
        ]
    )
    app = create_app(
        database_path=database_path,
        model=model,
        customer_identity=customer_identity("customer-1"),
    )

    with TestClient(app) as client:
        run = client.post(
            "/runs",
            json={"message": "羊毛看起来不错"},
        )
        memories = client.get("/memories", params={"query": "羊毛"})

    assert run.status_code == 200
    assert run.json()["memory_events"] == []
    assert "verbatim" in json.dumps(model.inputs[1], ensure_ascii=False)
    assert memories.json()["memories"] == []


def test_memory_rejects_a_blank_fact_after_normalization(tmp_path: Path) -> None:
    model = ScriptedModel(
        [
            [
                ResponseFunctionToolCall(
                    arguments=json.dumps(
                        {"fact": "   ", "explicitly_stated": True, "stable": True}
                    ),
                    call_id="blank-memory-1",
                    name="save_customer_memory",
                    type="function_call",
                )
            ],
            "没有可保存的客户事实。",
        ]
    )
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=model,
        customer_identity=customer_identity("customer-1"),
    )

    with TestClient(app) as client:
        run = client.post(
            "/runs",
            json={"message": "请记住"},
        )

    assert run.status_code == 200
    assert run.json()["memory_events"] == []
    assert "must not be blank" in json.dumps(model.inputs[1], ensure_ascii=False)


def test_agent_session_cannot_be_reused_by_another_customer(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.sqlite"
    model = ScriptedModel(["第一位客户的回复"])
    first_app = create_app(
        database_path=database_path,
        model=model,
        customer_identity=customer_identity("customer-1"),
    )

    with TestClient(first_app) as client:
        first = client.post(
            "/runs",
            json={"message": "第一位客户的消息"},
        )

    second_model = ScriptedModel([])
    second_app = create_app(
        database_path=database_path,
        model=second_model,
        customer_identity=customer_identity("customer-2"),
    )
    with TestClient(second_app) as client:
        second = client.post(
            "/runs",
            json={
                "session_id": first.json()["session_id"],
                "message": "第二位客户的消息",
            },
        )

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json() == {"detail": "session_customer_mismatch"}
    assert len(model.inputs) == 1
    assert second_model.inputs == []


def test_model_can_create_a_traceable_human_support_receipt(tmp_path: Path) -> None:
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps(
                    {
                        "reason": "退款争议需要负责人判断",
                        "context": "客户称订单 ORD-1001 尚未退款",
                    },
                    ensure_ascii=False,
                ),
                call_id="call-support-1",
                name="create_handoff",
                type="function_call",
            ),
            "已创建人工支持请求。",
        ]
    )
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=model,
        customer_identity=customer_identity("customer-1"),
    )

    with TestClient(app) as client:
        run = client.post(
            "/runs",
            json={"customer_id": "customer-1", "message": "退款一直没到账"},
        )
        receipt = client.get(f"/support-requests/{run.json()['support_request_id']}")

    assert run.status_code == 200
    assert run.json()["status"] == "needs_human"
    assert run.json()["support_request_id"].startswith("support_")
    assert receipt.status_code == 200
    assert receipt.json() == {
        "id": run.json()["support_request_id"],
        "customer_id": "customer-1",
        "session_id": run.json()["session_id"],
        "reason": "退款争议需要负责人判断",
        "context": "退款一直没到账",
        "model_context": "客户称订单 ORD-1001 尚未退款",
        "prior_actions": [],
        "status": "open",
        "created_at": receipt.json()["created_at"],
        "updated_at": receipt.json()["updated_at"],
    }


def test_harness_forces_support_after_an_invalid_support_tool_call(tmp_path: Path) -> None:
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"reason": "", "context": ""}),
                call_id="call-invalid-support",
                name="create_handoff",
                type="function_call",
            ),
            "请联系人工客服。",
        ]
    )
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=model,
        customer_identity=customer_identity("customer-2"),
    )

    with TestClient(app) as client:
        run = client.post(
            "/runs",
            json={"customer_id": "customer-2", "message": "处理这个不支持的操作"},
        )
        receipt = client.get(f"/support-requests/{run.json()['support_request_id']}")

    assert run.status_code == 200
    assert run.json()["status"] == "needs_human"
    assert run.json()["reply"] == "业务无法安全完成，已创建可追踪的人工支持请求。"
    assert receipt.json()["customer_id"] == "customer-2"
    assert receipt.json()["reason"] == "Harness 强制升级"
    assert receipt.json()["context"] == "处理这个不支持的操作"
    assert receipt.json()["model_context"] == "create_handoff 调用失败或参数无效"
    assert receipt.json()["prior_actions"] == ["create_handoff:failed"]


def test_duplicate_support_requests_return_one_stable_receipt(tmp_path: Path) -> None:
    def tool_call(call_id: str) -> ResponseFunctionToolCall:
        return ResponseFunctionToolCall(
            arguments=json.dumps({"reason": "退款争议", "context": "ORD-1001"}),
            call_id=call_id,
            name="create_handoff",
            type="function_call",
        )

    second_call = ResponseFunctionToolCall(
        arguments=json.dumps({"reason": "仍是退款问题", "context": "换一种说法"}),
        call_id="call-2",
        name="create_handoff",
        type="function_call",
    )
    model = ScriptedModel([tool_call("call-1"), "已提交。", second_call, "仍在处理中。"])
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=model,
        customer_identity=customer_identity("customer-1"),
        request_identity=lambda: "request-duplicate",
    )

    with TestClient(app) as client:
        first = client.post(
            "/runs",
            json={
                "message": "申请人工",
            },
        )
        second = client.post(
            "/runs",
            json={
                "session_id": first.json()["session_id"],
                "message": "再次申请人工",
            },
        )
        receipts = client.get("/support-requests")

    assert first.json()["support_request_id"] == second.json()["support_request_id"]
    assert len(receipts.json()) == 1


def test_plain_support_wording_is_not_reported_as_a_completed_handoff(tmp_path: Path) -> None:
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=ScriptedModel(["请联系人工客服。"]),
    )

    with TestClient(app) as client:
        run = client.post("/runs", json={"message": "帮我处理"})
        receipts = client.get("/support-requests")

    assert run.json()["status"] == "responded"
    assert run.json()["support_request_id"] is None
    assert receipts.json() == []


def test_support_write_failure_is_traced_and_not_reported_as_handoff(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.sqlite"
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"reason": "需要授权", "context": "退款"}),
                call_id="call-write-failure",
                name="create_handoff",
                type="function_call",
            ),
            "已转人工。",
        ]
    )
    app = create_app(database_path=database_path, model=model)
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TRIGGER reject_support_writes
            BEFORE INSERT ON support_requests
            BEGIN SELECT RAISE(FAIL, 'support store unavailable'); END
            """
        )

    with TestClient(app) as client:
        run = client.post("/runs", json={"message": "需要人工授权"})
        spans = client.get(f"/traces/{run.headers['x-trace-id']}/spans")

    assert run.status_code == 500
    assert run.json() == {"detail": "handoff_persistence_failed"}
    assert any(span["status"] == "failed" and "handoff" in span["summary"] for span in spans.json())


def test_forced_handoff_traces_failed_tool_and_created_receipt(tmp_path: Path) -> None:
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"reason": "", "context": ""}),
                call_id="call-invalid",
                name="create_handoff",
                type="function_call",
            ),
            "请联系客服。",
        ]
    )
    app = create_app(database_path=tmp_path / "chatty.sqlite", model=model)

    with TestClient(app) as client:
        run = client.post("/runs", json={"message": "无法安全完成"})
        spans = client.get(f"/traces/{run.json()['trace_id']}/spans")

    tool_events = [span for span in spans.json() if span["span_type"] == "tool"]
    assert [(event["status"], event["summary"]) for event in tool_events] == [
        ("failed", "create_handoff failed"),
        ("completed", "Harness-enforced handoff receipt created"),
    ]


def test_invalid_model_tool_is_forced_into_the_same_handoff_path(tmp_path: Path) -> None:
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments="{}",
                call_id="call-unknown",
                name="delete_everything",
                type="function_call",
            )
        ]
    )
    app = create_app(database_path=tmp_path / "chatty.sqlite", model=model)

    with TestClient(app) as client:
        run = client.post("/runs", json={"message": "执行不支持的操作"})
        receipt = client.get(f"/support-requests/{run.json()['support_request_id']}")

    assert run.json()["status"] == "needs_human"
    assert receipt.json()["reason"] == "Harness 拒绝无效操作"


def test_tool_permission_boundary_forces_a_traceable_handoff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(create_handoff, "needs_approval", True)
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"reason": "需要授权", "context": "退款审批"}),
                call_id="call-approval",
                name="create_handoff",
                type="function_call",
            )
        ]
    )
    app = create_app(database_path=tmp_path / "chatty.sqlite", model=model)

    with TestClient(app) as client:
        run = client.post("/runs", json={"message": "申请需要人工权限的操作"})
        receipt = client.get(f"/support-requests/{run.json()['support_request_id']}")

    assert run.json()["status"] == "needs_human"
    assert receipt.json()["reason"] == "Harness 需要人工权限或授权"
    assert receipt.json()["prior_actions"] == ["tool_permission:approval_required"]
