from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from agents import Model, ModelResponse, ModelSettings, ModelTracing, Usage
from agents.agent_output import AgentOutputSchemaBase
from agents.handoffs import Handoff
from agents.items import TResponseInputItem, TResponseStreamEvent
from agents.tool import Tool
from fastapi.testclient import TestClient
from openai.types.responses import ResponseOutputMessage, ResponseOutputText

from chatty.app import create_app


class ToolRecordingModel(Model):
    def __init__(self) -> None:
        self.tool_names: list[str] = []

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
        self.tool_names = [tool.name for tool in tools]
        return ModelResponse(
            output=[
                ResponseOutputMessage(
                    id="message-integrated-seam",
                    content=[
                        ResponseOutputText(annotations=[], text="已收到。", type="output_text")
                    ],
                    role="assistant",
                    status="completed",
                    type="message",
                )
            ],
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


def test_one_agent_exposes_every_customer_service_tool_and_consistent_run_status(
    tmp_path: Path,
) -> None:
    model = ToolRecordingModel()
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=model,
        customer_identity=lambda: "trusted-customer",
        request_identity=lambda: "trusted-request",
    )

    with TestClient(app) as client:
        response = client.post(
            "/runs",
            json={
                "message": "你好",
                "customer_id": "spoofed-customer",
                "request_id": "spoofed-request",
            },
        )

    assert response.status_code == 200
    assert model.tool_names == [
        "search_knowledge",
        "search_customer_memory",
        "save_customer_memory",
        "check_availability",
        "create_order",
        "view_order",
        "confirm_order",
        "cancel_order",
        "create_handoff",
    ]
    body = response.json()
    assert body["customer_id"] == "trusted-customer"
    assert body["request_id"] == "trusted-request"
    assert body["status"] == "responded"
    assert body["business_outcome"] == "not_applicable"
    assert body["needs_human"] is False
    assert body["support_request_id"] is None
    assert body["completion_evidence"] is None


def test_all_read_models_initialize_against_one_sqlite_file(tmp_path: Path) -> None:
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=ToolRecordingModel(),
        customer_identity=lambda: "trusted-customer",
    )

    with TestClient(app) as client:
        orders = client.get("/orders")
        memories = client.get("/memories", params={"query": "羊毛"})
        handoffs = client.get("/support-requests")
        health = client.get("/health")

    assert orders.status_code == 200
    assert memories.status_code == 200
    assert handoffs.status_code == 200
    assert health.json() == {"status": "ok"}
