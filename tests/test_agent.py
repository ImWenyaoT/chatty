from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
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

from chatty.agent import RecommendationService, parse_recommendation_draft
from chatty.catalog import Catalog
from chatty.experiments import ExperimentMetrics
from chatty.models import RecommendationRequest


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
async def test_single_agent_runs_all_five_tools_and_returns_canonical_product() -> None:
    service = RecommendationService(
        Catalog(),
        ExperimentMetrics(),
        model=ScriptedModel(successful_script()),
        model_id="scripted-model",
    )
    response = await service.recommend(
        RecommendationRequest(
            user_id="user_active",
            num_items=1,
            context={"preferred_categories": ["耳机"]},
        )
    )
    assert response.products[0].product_id == "P003"
    assert response.products[0].price_cents == 189900
    assert "100%" not in response.products[0].marketing_copy
