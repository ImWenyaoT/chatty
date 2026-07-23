from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

import pytest
from agents import Model, ModelResponse, ModelSettings, ModelTracing, Usage
from agents.agent_output import AgentOutputSchemaBase
from agents.items import TResponseInputItem, TResponseStreamEvent
from agents.tool import Tool
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)

from chatty.agent import AGENT_INSTRUCTIONS, RecommendationService, parse_recommendation_draft
from chatty.catalog import Catalog
from chatty.experiments import ExperimentMetrics
from chatty.models import RecommendationRequest
from chatty.tools import TOOL_NAMES


@dataclass(frozen=True)
class ToolStep:
    call_id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class MessageStep:
    message_id: str
    text: str


class ScriptedModel(Model):
    def __init__(self, script: Sequence[ToolStep | MessageStep]) -> None:
        self._script = iter(script)
        self.calls: list[dict[str, Any]] = []

    async def get_response(
        self,
        system_instructions: str | None,
        input: str | list[TResponseInputItem],
        model_settings: ModelSettings,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: Any,
        tracing: ModelTracing,
        *,
        previous_response_id: str | None,
        conversation_id: str | None,
        prompt: Any,
    ) -> ModelResponse:
        assert output_schema is None
        self.calls.append(
            {
                "system_instructions": system_instructions,
                "input": deepcopy(input),
                "tool_names": [tool.name for tool in tools],
            }
        )
        try:
            step = next(self._script)
        except StopIteration:
            raise RuntimeError("script exhausted") from None
        if isinstance(step, ToolStep):
            output: list[Any] = [
                ResponseFunctionToolCall(
                    arguments=json.dumps(step.arguments, ensure_ascii=False),
                    call_id=step.call_id,
                    name=step.name,
                    type="function_call",
                )
            ]
        else:
            output = [
                ResponseOutputMessage(
                    id=step.message_id,
                    content=[
                        ResponseOutputText(
                            annotations=[],
                            text=step.text,
                            type="output_text",
                        )
                    ],
                    role="assistant",
                    status="completed",
                    type="message",
                )
            ]
        return ModelResponse(output=output, usage=Usage(), response_id=None)

    def stream_response(self, *args: Any, **kwargs: Any) -> AsyncIterator[TResponseStreamEvent]:
        raise NotImplementedError


def successful_script() -> list[ToolStep | MessageStep]:
    return [
        ToolStep("call-1", "get_user_profile", {}),
        ToolStep(
            "call-2",
            "search_products",
            {
                "categories": ["耳机"],
                "min_price_cents": 0,
                "max_price_cents": 300000,
                "tags": [],
                "limit": 5,
            },
        ),
        ToolStep("call-3", "check_inventory", {"product_ids": ["P003", "P004"]}),
        ToolStep(
            "call-4",
            "retrieve_knowledge",
            {
                "query": "降噪 耳机",
                "categories": ["耳机"],
                "product_ids": ["P003", "P004"],
                "limit": 3,
            },
        ),
        ToolStep("call-5", "get_marketing_strategy", {"segment": "active"}),
        MessageStep(
            "message-1",
            json.dumps(
                {
                    "recommendations": [
                        {
                            "product_id": "P003",
                            "reason": "符合近期关注的降噪耳机需求",
                            "marketing_copy": "100%沉浸降噪，通勤更从容",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
        ),
    ]


def test_parses_json_from_markdown_code_block() -> None:
    draft = parse_recommendation_draft(
        "推荐如下：\n"
        "```json\n"
        '{"recommendations":[{"product_id":"P003","reason":"适合通勤",'
        '"marketing_copy":"沉浸聆听"}]}\n'
        "```"
    )

    assert draft.recommendations[0].product_id == "P003"


def test_rejects_prose_without_json() -> None:
    with pytest.raises(ValueError):
        parse_recommendation_draft("推荐 P003")


@pytest.mark.asyncio
async def test_single_agent_runs_all_five_tools_and_returns_canonical_product(
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setenv("CHATTY_AGENT_DEBUG", "1")
    model = ScriptedModel(successful_script())
    request = RecommendationRequest(
        user_id="user_active",
        num_items=1,
        context={"preferred_categories": ["耳机"]},
    )
    service = RecommendationService(
        Catalog(),
        ExperimentMetrics(),
        model=model,
        model_id="scripted-model",
    )
    response = await service.recommend(request)
    assert response.products[0].product_id == "P003"
    assert response.products[0].price_cents == 189900
    assert "100%" not in response.products[0].marketing_copy

    assert all(call["system_instructions"] == AGENT_INSTRUCTIONS for call in model.calls)
    assert all(call["tool_names"] == list(TOOL_NAMES) for call in model.calls)
    assert model.calls[0]["input"][0]["content"] == request.model_dump_json()

    events = [
        json.loads(line.removeprefix("agent_trace "))
        for line in capsys.readouterr().err.splitlines()
        if line.startswith("agent_trace ")
    ]
    assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
    assert [event["event"] for event in events] == (
        ["llm_input", "llm_output", "tool_call", "tool_result"] * 5
        + ["llm_input", "llm_output", "agent_output", "response"]
    )
    for index, tool_name in enumerate(TOOL_NAMES):
        _, _, tool_call, tool_result = events[index * 4 : index * 4 + 4]
        assert tool_call["tool_name"] == tool_result["tool_name"] == tool_name
        assert tool_call["call_id"] == tool_result["call_id"]
        assert isinstance(tool_result["result"], dict | list)

    for index, call in enumerate(model.calls[1:], start=1):
        previous_call, previous_result = call["input"][-2:]
        assert previous_call["type"] == "function_call"
        assert previous_result["type"] == "function_call_output"
        assert previous_call["call_id"] == previous_result["call_id"] == f"call-{index}"

    llm_inputs = [event for event in events if event["event"] == "llm_input"]
    assert llm_inputs[0]["request"] == request.model_dump(mode="json")
    assert all(event["omitted_reasoning_items"] == 0 for event in llm_inputs)
    assert events[-1]["output"]["products"][0]["marketing_copy"] == "***沉浸降噪，通勤更从容"
