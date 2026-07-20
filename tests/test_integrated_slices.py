from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from agents import Model, ModelResponse, ModelSettings, ModelTracing, Usage
from agents.agent_output import AgentOutputSchemaBase
from agents.handoffs import Handoff
from agents.items import TResponseInputItem, TResponseStreamEvent
from agents.tool import Tool
from fastapi.testclient import TestClient
from openai.types.responses import ResponseOutputMessage, ResponseOutputText

from chatty.app import create_app
from chatty.run import ChattyRunModule, RunInput
from chatty.runtime import ChattyRuntime
from chatty.store import TraceStore


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


@pytest.mark.asyncio
async def test_run_module_returns_the_completed_run_and_persists_its_trace(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "chatty.sqlite"
    runs = ChattyRunModule(
        database_path=database_path,
        model=ToolRecordingModel(),
        model_id="run-module-test-model",
    )

    result = await runs.run(
        RunInput(
            message="你好",
            customer_id="trusted-customer",
            request_id="trusted-request",
        )
    )
    trace = TraceStore(database_path).get(result.trace_id)

    assert result.customer_id == "trusted-customer"
    assert result.request_id == "trusted-request"
    assert result.status == "responded"
    assert result.business_outcome == "not_applicable"
    assert result.session_id.startswith("session_")
    assert trace is not None
    assert trace.status == "completed"
    assert trace.model_id == "run-module-test-model"
    assert trace.business_outcome == "not_applicable"


@pytest.mark.asyncio
async def test_each_run_module_persists_its_trace_to_its_own_runtime(
    tmp_path: Path,
) -> None:
    first_database = tmp_path / "first.sqlite"
    second_database = tmp_path / "second.sqlite"
    first_runs = ChattyRunModule(
        database_path=first_database,
        model=ToolRecordingModel(),
        model_id="first-runtime-model",
    )
    ChattyRunModule(
        database_path=second_database,
        model=ToolRecordingModel(),
        model_id="second-runtime-model",
    )

    result = await first_runs.run(
        RunInput(
            message="你好",
            customer_id="trusted-customer",
            request_id="trusted-request",
        )
    )

    first_trace = TraceStore(first_database).get(result.trace_id)
    second_trace = TraceStore(second_database).get(result.trace_id)
    assert first_trace is not None
    assert first_trace.model_id == "first-runtime-model"
    assert second_trace is None


def test_run_module_rejects_path_configuration_with_an_existing_runtime(
    tmp_path: Path,
) -> None:
    runtime = ChattyRuntime.open(tmp_path / "runtime.sqlite")

    with pytest.raises(ValueError, match="runtime owns database and knowledge paths"):
        ChattyRunModule(
            database_path=tmp_path / "ignored.sqlite",
            runtime=runtime,
            model=ToolRecordingModel(),
        )


def test_run_response_keeps_optional_support_receipt_in_openapi(tmp_path: Path) -> None:
    app = create_app(database_path=tmp_path / "chatty.sqlite", model=ToolRecordingModel())

    schema = app.openapi()["components"]["schemas"]["CompletedRun"]

    assert "support_request_id" not in schema["required"]


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
