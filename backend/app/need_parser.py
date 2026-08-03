from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

from app.models import UserContext

Complete = Callable[[str, str | None], Awaitable[str]]


class NeedParseError(ValueError):
    """模型没有返回可信的购物条件。"""


def _instructions(categories: list[str]) -> str:
    category_text = "、".join(categories)
    return (
        '把购物需求转成 JSON，只输出 JSON：{"category":"类目或 null",'
        '"min_yuan":数字或 null,"max_yuan":数字或 null}。'
        "单个价格（如“200元的”“预算200”）默认是上限，只填 max_yuan；"
        "“以上/起”只填 min_yuan；“到/至”才同时填写区间。"
        f"可选类目：{category_text}"
    )


async def parse_need(
    complete: Complete,
    text: str,
    categories: list[str],
) -> UserContext:
    raw = await complete(text, _instructions(categories))
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        raise NeedParseError("missing_need_json")

    try:
        value = json.loads(raw[start : end + 1])
    except json.JSONDecodeError as error:
        raise NeedParseError("invalid_need_json") from error

    if not isinstance(value, dict):
        raise NeedParseError("invalid_need_shape")

    context = UserContext()
    category = value.get("category")
    if category is not None:
        if not isinstance(category, str) or category not in categories:
            raise NeedParseError("invalid_need_category")
        context.preferred_categories = [category]

    min_yuan = value.get("min_yuan")
    max_yuan = value.get("max_yuan")
    for name, amount in (("min_yuan", min_yuan), ("max_yuan", max_yuan)):
        if amount is not None and (
            not isinstance(amount, int | float)
            or isinstance(amount, bool)
            or amount < 0
        ):
            raise NeedParseError(f"invalid_{name}")
    if min_yuan is not None:
        context.min_price_cents = round(min_yuan * 100)
    if max_yuan is not None:
        context.max_price_cents = round(max_yuan * 100)
    if (
        context.min_price_cents is not None
        and context.max_price_cents is not None
        and context.min_price_cents > context.max_price_cents
    ):
        raise NeedParseError("invalid_need_price_range")
    return context


def describe(context: UserContext) -> str:
    parts = list(context.preferred_categories or ["不限类目"])
    if context.min_price_cents:
        parts.append(f"≥{round(context.min_price_cents / 100)} 元")
    if context.max_price_cents:
        parts.append(f"≤{round(context.max_price_cents / 100)} 元")
    return " · ".join(parts)
