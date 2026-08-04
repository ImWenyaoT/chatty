from __future__ import annotations

import json
from typing import Annotated

from agents import (
    Agent,
    ItemHelpers,
    ModelSettings,
    RunErrorHandlerInput,
    RunErrorHandlerResult,
)
from pydantic import BaseModel, Field

from app.data.models import ProductNeed, TaskFrame, UserContext
from app.model_provider import ResponsesModelProvider


class TaskFrameWire(BaseModel):
    """DeepSeek Responses API 可接受的扁平 structured output。"""

    product_requested: bool
    category: list[str] = Field(max_length=1)
    min_yuan: list[Annotated[float, Field(ge=0)]] = Field(max_length=1)
    max_yuan: list[Annotated[float, Field(ge=0)]] = Field(max_length=1)
    knowledge_query: list[str] = Field(max_length=1)


class TaskFrameParseError(ValueError):
    """模型返回的 TaskFrame 无法安全映射到当前业务数据。"""


def _instructions(categories: list[str]) -> str:
    category_text = "、".join(categories)
    return (
        "把整段用户对话整理成一个结构化 TaskFrame。"
        "TaskFrameWire 是扁平结构，所有字段都必须填写。"
        "用户要求推荐、查找或比较商品时，product_requested=true；否则为 false。"
        "category、min_yuan、max_yuan 和 knowledge_query 都是最多一个元素的数组；"
        "对应内容不存在时填写空数组。"
        "单个价格默认是上限；以上或起是下限；到或至才同时填写区间。"
        "用户询问快递、退换货等已有规则或事实时，把适合检索的简短表达填入"
        "knowledge_query；没有知识问题时填空数组。混合请求必须同时保留两部分。"
        "后续短回答用于补充前文，最新的明确约束覆盖旧约束。"
        f"商品可选类目：{category_text}。"
        "不要创建 intent、goal、route 或支付相关字段。"
    )


def build_task_frame_agent(
    provider: ResponsesModelProvider,
    categories: list[str],
) -> Agent[None]:
    """使用 Agents SDK structured output 声明 TaskFrame 契约。"""

    return Agent[None](
        name="Chatty Task Framer",
        instructions=_instructions(categories),
        model=provider.agent_model,
        output_type=TaskFrameWire,
        model_settings=ModelSettings(reasoning={"effort": "none"}),
    )


async def recover_invalid_task_frame(
    data: RunErrorHandlerInput[None],
) -> RunErrorHandlerResult:
    """兼容 DeepSeek 把 structured output 包在 properties 中的响应。"""

    raw = "".join(
        ItemHelpers.extract_text(item) or ""
        for response in data.run_data.raw_responses
        for item in response.output
    )
    wire = parse_task_frame_wire_output(raw)
    return RunErrorHandlerResult(final_output=wire)


def parse_task_frame_wire_output(raw: str) -> TaskFrameWire:
    """只在 invalid_final_output 路径解开 DeepSeek 的 properties 包装。"""

    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or not isinstance(value.get("properties"), dict):
            raise ValueError("task_frame_properties_wrapper_required")
        return TaskFrameWire.model_validate(value["properties"])
    except (json.JSONDecodeError, ValueError) as error:
        raise TaskFrameParseError("invalid_task_frame_output") from error


def parse_task_frame(
    frame: TaskFrameWire,
    categories: list[str],
) -> TaskFrame:
    """校验动态业务边界；不根据关键词在 Harness 中再次猜测语义。"""

    category = frame.category[0].strip() or None if frame.category else None
    min_yuan = frame.min_yuan[0] if frame.min_yuan else None
    max_yuan = frame.max_yuan[0] if frame.max_yuan else None
    if frame.product_requested:
        if category is not None and category not in categories:
            raise TaskFrameParseError("invalid_product_category")
        if min_yuan is not None and max_yuan is not None and min_yuan > max_yuan:
            raise TaskFrameParseError("invalid_product_price_range")
        product_need = ProductNeed(
            category=category,
            min_yuan=min_yuan,
            max_yuan=max_yuan,
        )
    else:
        if category is not None or min_yuan is not None or max_yuan is not None:
            raise TaskFrameParseError("product_fields_without_request")
        product_need = None

    knowledge_query = (
        frame.knowledge_query[0].strip() or None if frame.knowledge_query else None
    )
    try:
        return TaskFrame(
            product_need=product_need,
            knowledge_query=knowledge_query,
        )
    except ValueError as error:
        raise TaskFrameParseError("empty_task_frame") from error


def product_context(need: ProductNeed) -> UserContext:
    context = UserContext()
    if need.category is not None:
        context.preferred_categories = [need.category]
    if need.min_yuan is not None:
        context.min_price_cents = round(need.min_yuan * 100)
    if need.max_yuan is not None:
        context.max_price_cents = round(need.max_yuan * 100)
    return context


def describe_task_frame(frame: TaskFrame) -> str:
    parts: list[str] = []
    need = frame.product_need
    if need is not None:
        parts.extend([need.category or "不限类目"])
        if need.min_yuan is not None:
            parts.append(f"≥{round(need.min_yuan)} 元")
        if need.max_yuan is not None:
            parts.append(f"≤{round(need.max_yuan)} 元")
    if frame.knowledge_query:
        parts.append(f"知识 · {frame.knowledge_query}")
    return " · ".join(parts)
