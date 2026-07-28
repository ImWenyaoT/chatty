from __future__ import annotations

import json
import logging
from typing import Any

from agents import Agent
from agents.items import ModelResponse, TResponseInputItem
from agents.lifecycle import RunHooksBase
from agents.run_context import AgentHookContext, RunContextWrapper
from agents.tool import Tool
from pydantic import BaseModel

from chatty.models import RecommendationResponse
from chatty.tools import RecommendationContext

logger = logging.getLogger("chatty.agent")


def _jsonable(value: object) -> object:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, BaseModel):
        return _jsonable(value.model_dump(mode="json"))
    return str(value)


def _structured_text(value: object) -> object:
    if not isinstance(value, str):
        return _jsonable(value)
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


class AgentDebugHooks(RunHooksBase[RecommendationContext, Agent[RecommendationContext]]):
    def __init__(self, model_id: str) -> None:
        # 独立 handler 保证脚本和 Uvicorn 两种启动方式都能看到调试轨迹。
        if not logger.handlers:
            logger.addHandler(logging.StreamHandler())
        logger.setLevel(logging.INFO)
        logger.propagate = False
        self.model_id = model_id
        self.sequence = 0

    def _emit(self, event: str, **payload: object) -> None:
        self.sequence += 1
        logger.info(
            "agent_trace %s",
            json.dumps(
                {"sequence": self.sequence, "event": event, **payload},
                ensure_ascii=False,
            ),
        )

    async def on_llm_start(
        self,
        context: RunContextWrapper[RecommendationContext],
        agent: Agent[RecommendationContext],
        system_prompt: str | None,
        input_items: list[TResponseInputItem],
    ) -> None:
        observable_items = []
        omitted_reasoning_items = 0
        for item in input_items:
            item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
            if item_type == "reasoning":
                omitted_reasoning_items += 1
                continue
            observable_items.append(_jsonable(item))
        self._emit(
            "llm_input",
            model_id=self.model_id,
            system_instructions=system_prompt,
            request=context.context.request.model_dump(mode="json"),
            input_items=observable_items,
            omitted_reasoning_items=omitted_reasoning_items,
        )

    async def on_llm_end(
        self,
        context: RunContextWrapper[RecommendationContext],
        agent: Agent[RecommendationContext],
        response: ModelResponse,
    ) -> None:
        output_items = []
        omitted_reasoning_items = 0
        for item in response.output:
            item_type = getattr(item, "type", None)
            if item_type == "reasoning":
                omitted_reasoning_items += 1
            elif item_type == "function_call":
                output_items.append(
                    {
                        "type": item_type,
                        "call_id": getattr(item, "call_id", None),
                        "name": getattr(item, "name", None),
                        "arguments": _structured_text(getattr(item, "arguments", None)),
                    }
                )
            elif item_type == "message":
                output_items.append(
                    {
                        "type": item_type,
                        "role": getattr(item, "role", None),
                        "text": [
                            getattr(content, "text", "")
                            for content in getattr(item, "content", [])
                            if getattr(content, "type", None) == "output_text"
                        ],
                    }
                )
        self._emit(
            "llm_output",
            output_items=output_items,
            omitted_reasoning_items=omitted_reasoning_items,
        )

    async def on_tool_start(
        self,
        context: RunContextWrapper[RecommendationContext],
        agent: Agent[RecommendationContext],
        tool: Tool,
    ) -> None:
        self._emit(
            "tool_call",
            call_id=getattr(context, "tool_call_id", None),
            tool_name=tool.name,
            arguments=_structured_text(getattr(context, "tool_arguments", None)),
        )

    async def on_tool_end(
        self,
        context: RunContextWrapper[RecommendationContext],
        agent: Agent[RecommendationContext],
        tool: Tool,
        result: object,
    ) -> None:
        self._emit(
            "tool_result",
            call_id=getattr(context, "tool_call_id", None),
            tool_name=tool.name,
            result=_structured_text(result),
        )

    async def on_agent_end(
        self,
        context: AgentHookContext[RecommendationContext],
        agent: Agent[RecommendationContext],
        output: Any,
    ) -> None:
        self._emit("agent_output", output=_structured_text(output))

    def record_response(self, response: RecommendationResponse) -> None:
        self._emit("response", output=_jsonable(response))

    def record_failure(self, code: str) -> None:
        self._emit("failure", code=code)
