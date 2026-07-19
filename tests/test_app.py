import json
import sqlite3
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

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

from chatty.app import create_app


class ScriptedModel(Model):
    def __init__(self, replies: list[str | ResponseFunctionToolCall]) -> None:
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
    assert first_body["status"] == "completed"
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


def test_empty_model_output_is_not_reported_as_a_completed_run(tmp_path: Path) -> None:
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=ScriptedModel([""]),
    )

    with TestClient(app) as client:
        response = client.post("/runs", json={"message": "你好"})

    assert response.status_code == 502
    assert response.json() == {"detail": "llm_provider_failed"}


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
    assert model.tool_names[0] == ["search_knowledge"]
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
