"""把用户原话转换为简单、可校验的 TaskFrame。

这个文件只负责“理解用户要做什么”，不搜索商品、不查库存、也不生成最终回复。
TaskFrameWire 是 Model 输出的临时形状；TaskFrame 是 Harness 真正使用的领域对象。
二者分开后，外部 Model 的格式限制不会污染后面的业务代码。
"""

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
    """DeepSeek Responses API 可接受的扁平 structured output。

    这些字段虽然写成 Python 类型，但 BaseModel 会让 Pydantic 在运行时真正校验它们。
    list 最多只有一个元素，是为了兼容 provider 的 structured output 能力。
    """

    product_requested: bool
    category: list[str] = Field(max_length=1)
    min_yuan: list[Annotated[float, Field(ge=0)]] = Field(max_length=1)
    max_yuan: list[Annotated[float, Field(ge=0)]] = Field(max_length=1)
    knowledge_query: list[str] = Field(max_length=1)


class TaskFrameParseError(ValueError):
    """模型返回的 TaskFrame 无法安全映射到当前业务数据。"""


def _instructions(categories: list[str]) -> str:
    """把 SQLite 中真实存在的商品类目写入 Task Framer Instructions。"""

    # join 把 ["耳机", "键盘"] 变成适合给 Model 阅读的“耳机、键盘”。
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

    # Agent[None] 表示这个小 Agent 不需要额外 RunContext。
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

    # provider 返回内容可能分成多个 output item，先把所有文本片段拼成一个 JSON 字符串。
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
        # json.loads 的结果类型是动态的，所以先用 isinstance 缩小到 dict。
        value = json.loads(raw)
        if not isinstance(value, dict) or not isinstance(value.get("properties"), dict):
            raise ValueError("task_frame_properties_wrapper_required")
        # model_validate 在运行时检查 bool、list、float 以及长度和最小值。
        return TaskFrameWire.model_validate(value["properties"])
    except (json.JSONDecodeError, ValueError) as error:
        raise TaskFrameParseError("invalid_task_frame_output") from error


def parse_task_frame(
    frame: TaskFrameWire,
    categories: list[str],
) -> TaskFrame:
    """校验动态业务边界；不根据关键词在 Harness 中再次猜测语义。"""

    # Wire 用空列表表示“没有值”；领域对象统一改成更直接的 None。
    category = frame.category[0].strip() or None if frame.category else None
    min_yuan = frame.min_yuan[0] if frame.min_yuan else None
    max_yuan = frame.max_yuan[0] if frame.max_yuan else None
    if frame.product_requested:
        # category 必须来自 SQLite 提供的当前类目，Model 不能发明不存在的类目。
        if category is not None and category not in categories:
            raise TaskFrameParseError("invalid_product_category")
        if min_yuan is not None and max_yuan is not None and min_yuan > max_yuan:
            raise TaskFrameParseError("invalid_product_price_range")
        # ProductNeed 是 Pydantic Model，创建时还会执行它自己的字段约束。
        product_need = ProductNeed(
            category=category,
            min_yuan=min_yuan,
            max_yuan=max_yuan,
        )
    else:
        # Model 说“不需要商品”时，不允许同时偷偷带上类目或价格。
        if category is not None or min_yuan is not None or max_yuan is not None:
            raise TaskFrameParseError("product_fields_without_request")
        product_need = None

    # 空字符串也归一化成 None，后续只需要判断 `is not None`。
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
    """把 TaskFrame 中的商品需求转换为 Catalog 使用的搜索条件。"""

    # UserContext 给出安全默认值，因此先创建空对象，再复制用户明确说出的字段。
    context = UserContext()
    if need.category is not None:
        context.preferred_categories = [need.category]
    if need.min_yuan is not None:
        # 对外展示使用“元”，SQLite 整数价格使用“分”，避免浮点金额误差。
        context.min_price_cents = round(need.min_yuan * 100)
    if need.max_yuan is not None:
        context.max_price_cents = round(need.max_yuan * 100)
    return context


def describe_task_frame(frame: TaskFrame) -> str:
    """把结构化 TaskFrame 转回简短中文，供 UI 展示“理解为”。"""

    # parts 按需加入类目、价格和知识问题，最后用中点连接。
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
