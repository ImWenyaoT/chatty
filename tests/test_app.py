import json
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


class ScriptedModel(Model):
    def __init__(self, replies: list[str]) -> None:
        self.replies = iter(replies)
        self.inputs: list[str | list[TResponseInputItem]] = []
        self.settings: list[ModelSettings] = []
        self.tracings: list[ModelTracing] = []

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
        reply = next(self.replies)
        return ModelResponse(
            output=[
                ResponseOutputMessage(
                    id=f"message-{len(self.inputs)}",
                    content=[ResponseOutputText(annotations=[], text=reply, type="output_text")],
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
